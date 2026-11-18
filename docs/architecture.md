# Stok / Fiyat Senkron Servisi — Mimari

Amaç: bir webshop'un (WooCommerce, Shopify, CSV/XML tedarikçi feed'i veya ERP) stok ve
fiyat bilgisini Bol.com satıcı hesabına **fazla satış yapmadan** ve **rate limit yemeden**
aktarmak.

Tasarımın tek cümlelik özeti: kaynak sistem gerçeği söyler, kurallar motoru hedefi hesaplar,
kuyruk tek tek iter, mutabakat sapmayı yakalar.

```
kaynak (webhook/poll)
      │
      ▼
 source_state  ──►  planner (safety stock + price rules)  ──►  offer_state.desired_*
                                                                     │
                                                              differ │ (eşik + öncelik)
                                                                     ▼
                                                               sync_jobs (kuyruk)
                                                                     │
                                                      limiter ──► worker ──► Bol v11 PATCH
                                                                     │
                                                                     ▼
                                                             offer_state.pushed_*
                                                                     ▲
                       reconciler (15 dk, GET /retailer/offers) ─────┘
```

---

## 1. Neden v11

v10'da stok ve fiyat iki ayrı `PUT` ve her biri **202** dönüp `processStatusId` veriyor;
sonucu öğrenmek için ayrıca polling gerekiyor. v11'de tek `PATCH` ile ikisi birden
güncelleniyor ve **204** ile iş bitmiş oluyor.

Pratik sonuç: 5.000 ürünlük bir kataloğun tam güncellemesi

- v10: 10.000 yazma + 10.000 process status sorgusu
- v11: 5.000 yazma, polling yok

`src/bol/offers.v10.js` yine de duruyor. Müşterinin hesabı v11'e açılmamışsa
tek satırlık konfigürasyonla (`BOL_OFFERS_API_VERSION=v10`) eski uçlara düşülür.

---

## 2. Tablo yapısı

Postgres. Küçük kurulumlar için aynı şema SQLite'ta da çalışır (`uuid` → `text`,
`jsonb` → `text`, `numeric` → `real`).

| Tablo | Ne tutar | Kritik nokta |
|---|---|---|
| `tenants` | Müşteri + şifrelenmiş Bol kimlik bilgileri | `rate_budget_pct` ile limitin kaçta kaçını kullanacağımız |
| `products` | sku ↔ ean ↔ `offer_id` eşlemesi | `offer_id` yoksa önce EAN'den çözülür |
| `source_state` | Kaynağın söylediği ham stok/fiyat | `payload_hash` ile gereksiz iş elenir |
| `offer_state` | `desired_*`, `pushed_*`, `bol_*` üç katman | Üç katmanın ayrılması mutabakatın temeli |
| `safety_stock_rules` | Tampon kuralları (tenant veya sku kapsamlı) | `priority` ile en dar kural kazanır |
| `price_rules` | Taban, tavan, yuvarlama, maksimum değişim | `max_change_pct` fiyat kazası sigortası |
| `sync_jobs` | Kuyruk | `dedupe_key` ile ürün başına tek bekleyen iş |
| `sync_log` | Her HTTP çağrısının isteği/cevabı | Müşteriye "ne zaman ne gönderdik" kanıtı |
| `dead_letters` | Kalıcı hatalar | Sessizce kaybolan ürün olmaz |
| `rate_buckets` | Token bucket'ın kalıcı hâli | Çok işlemli kurulumda ortak kova |

### Neden üç katman stok (`desired` / `pushed` / `bol`)

- `desired_stock` — kuralları uyguladıktan sonra göndermek **istediğimiz** sayı.
- `pushed_stock` — en son gerçekten **gönderdiğimiz** sayı.
- `bol_stock` + `bol_corrected_stock` — Bol'un **okuduğumuzda söylediği** sayı.

`pushed != bol` ise bizim dışımızda bir şey offer'a dokunmuş demektir (müşteri panelden
elle değiştirdi, başka bir araç yazdı). Bu fark alarm üretir; tek katmanlı tasarımda
bu durum görünmez ve fazla satış buradan çıkar.

Şema: `src/db/schema.sql`

---

## 3. Kuyruk

Ayrı bir Redis/RabbitMQ kurulmuyor. Postgres tablosu + `FOR UPDATE SKIP LOCKED` yeterli;
tek konteynerde çalışır, müşterinin VPS'ine ek bağımlılık getirmez.

```sql
UPDATE sync_jobs SET status = 'running', locked_by = $1, locked_at = now()
WHERE id IN (
  SELECT id FROM sync_jobs
  WHERE status = 'pending' AND run_after <= now()
  ORDER BY priority ASC, run_after ASC
  FOR UPDATE SKIP LOCKED
  LIMIT $2
)
RETURNING *;
```

**İş tipleri**

| Tip | Ne yapar | Öncelik |
|---|---|---|
| `push_offer` (stok **düşüşü**) | Bol'a PATCH | **10** |
| `push_offer` (fiyat değişimi) | Bol'a PATCH | 50 |
| `push_offer` (stok **artışı**) | Bol'a PATCH | 80 |
| `resolve_offer_id` | EAN → offerId eşlemesi | 60 |
| `pull_source` | Kaynaktan çek | 90 |
| `reconcile` | Bol'u okuyup karşılaştır | 120 |

**Stok düşüşü her zaman öne alınır.** Fazla satışın maliyeti (iptal, satıcı puanı düşüşü)
geç yayınlanan fiyat artışından kat kat yüksektir.

**Tekilleştirme:** `dedupe_key = tenant_id:product_id:push_offer` üzerinde
`status IN ('pending','running')` koşullu unique index. Bir ürün dakikada 50 kez
değişse bile kuyrukta tek iş durur, en güncel hedefle çalışır.

**Toplu değil, tek tek:** v11'de toplu güncelleme ucu yok. 50/sn limiti ve %60 bütçe ile
saatte ~108.000 offer güncellenebilir; tek tek göndermek darboğaz değil.

### "Çalışırken değişti" yarışı — kuyruğun en sessiz hatası

Dedupe indeksi bir yan etki üretiyor: iş `running` durumdayken gelen yeni bir
enqueue aynı satırı günceller. Yani gönderimi yapan worker elindeki eski yükle
çalışırken satırın yükü değişmiş olur. İş bittiğinde `status='done'` yazılırsa
**o değişiklik sessizce kaybolur** — ve kaybolan şey tipik olarak bir stok düşüşü,
yani tam olarak fazla satışın başladığı yer.

Çözüm `markDone` içinde: `updated_at > locked_at` ise iş `done` değil `pending`
olarak kapanıyor ve hemen yeniden çalıştırılıyor. Postgres'te `UPDATE`'in sağ
tarafı eski değerleri gördüğü için karşılaştırma tek ifadede yapılabiliyor:

```sql
SET status = CASE WHEN updated_at > locked_at THEN 'pending' ELSE 'done' END
```

`attempts` da bilerek **claim anında** artıyor, hata anında değil. Süreci
çökerten bir iş böylece sonsuz döngüye girmiyor; `max_attempts`'a ulaşıp
`dead_letters`'a düşüyor.

---

## 4. Safety stock kuralı

```
raw        = source_state.stock
buffer     = max(buffer_abs, ceil(raw * buffer_pct / 100))
candidate  = raw - buffer
if candidate < min_publish  ->  publish = 0
else                        ->  publish = min(candidate, max_publish, 999)
```

Varsayılan: `buffer_abs = 2`, `buffer_pct = 0`, `min_publish = 1`, `max_publish = 999`.

Ek kurallar:

1. **Asimetrik eşik.** Stok düşerken her değişiklik anında gönderilir.
   Stok artarken `abs(yeni - gönderilen) < stock_delta_threshold` (varsayılan 2) ise
   gönderilmez. Böylece 7↔8 arasında salınan bir ürün günde yüzlerce yazma üretmez.
2. **Sıfır özel durumdur.** Hedef 0 ise eşik dinlenmez, daima gönderilir.
3. **`managedByRetailer` seçimi tenant ayarıdır.** Bol siparişleri kaynak sisteme geri
   yazılıyorsa `true`, yazılmıyorsa `false`. Yanlış seçim doğrudan fazla satış demektir;
   detayı `docs/bol-api-notes.md` §3'te.
4. **Kaynak bayatsa dokunma.** `source_state.observed_at` `SOURCE_STALE_AFTER_MIN`
   dakikadan eskiyse plan üretilmez. Çöken bir kaynağın "0 stok" cevabı tüm kataloğu
   vitrinden düşürebilir — bu servisin yapabileceği en pahalı hata.
5. **Toplu düşüş sigortası.** Tek turda kataloğun `BULK_DROP_GUARD_PCT` oranından
   fazlası sıfıra düşüyorsa iş kuyruğu durdurulur ve uyarı yazılır. Neredeyse her zaman
   kaynak tarafında bozuk bir feed anlamına gelir.

Uygulama: `src/sync/safetyStock.js` — saf fonksiyon, yan etkisiz, doğrudan test edilebilir.

---

## 5. Fiyat kuralı

```
base    = source_state.price            (KDV dahil, EUR)
marked  = base * (1 + markup_pct / 100)
clamped = clamp(marked, floor_price, ceiling_price)
final   = round(clamped, rounding)      none | cent | psychological_99
```

Sigortalar:

- `final < 1` veya `final > 9999` → gönderilmez, dead letter. (Bol'un spec sınırı.)
- `abs(final - pushed_price) / pushed_price > max_change_pct` (varsayılan %25) →
  gönderilmez, manuel onay bekler. Kaynaktaki kuruş/euro karışıklığı burada yakalanır.
- `bundlePrices` daima `quantity: 1` elemanı içerir; kademeli fiyat varsa
  quantity artan, unitPrice azalan sırada doğrulanır.

Uygulama: `src/sync/pricing.js`

---

## 6. Rate limit yönetimi

Kova başına **token bucket**, tenant bazlı:

| Kova | Gerçek limit | Varsayılan bütçe (%60) |
|---|---|---|
| `offers_write` | 50 / sn | 30 / sn |
| `offers_read` | 25 / sn | 15 / sn |
| `process_status` | 100 / sn | 60 / sn |
| `process_status_bulk` | 2 / sn | 1 / sn |
| `export` | 9 / saat | 5 / saat |
| `orders_read` | 25 / dk | 15 / dk |

Kurallar:

- Limitler **satıcı hesabı başına**dır. Müşterinin başka bir aracı varsa aynı kovadan
  içiyoruz; bu yüzden %100 değil %60 kullanılır (`tenants.rate_budget_pct` ile ayarlanır).
- Her cevapta `X-RateLimit-Remaining` okunur. Kalan, kendi hesabımızdan düşükse kova
  **o değere indirilir** — yani gerçek kaynak Bol'un başlığıdır, bizim sayacımız değil.
- 429 gelirse `Retry-After` saniyesi aynen uygulanır ve kova sıfırlanır.
- Token yenileme ayrı ve çok daha dar bir limite tabi: token tek yerde tutulur,
  299 saniyelik ömrün 240. saniyesinde yenilenir, eşzamanlı yenileme single-flight'tır.

Uygulama: `src/core/limiter.js`, `src/bol/rateLimits.js`

---

## 7. Hata yönetimi

| Durum | Sınıf | Davranış |
|---|---|---|
| 400 | kalıcı | Dead letter + `products.sync_enabled = false`. Tekrar denenmez. |
| 401 | token | Token bir kez yenilenir, istek bir kez tekrarlanır. İkinci 401 → tenant durur. |
| 403 | geçici | Backoff. Üst üste 3 kez → tenant devre dışı, bildirim. |
| 404 (offer) | veri | `offer_id` temizlenir, `resolve_offer_id` kuyruğa girer. |
| 409 | çakışma | Offer yeniden okunur, plan yeniden hesaplanır, bir kez tekrar. |
| 429 | limit | `Retry-After` kadar beklenir, kova sıfırlanır, iş yeniden kuyruğa. |
| 5xx / timeout | geçici | Üstel backoff + jitter, en fazla 6 deneme. |
| Ağ hatası | geçici | Aynı. |

Backoff: `min(2^attempt * 1000ms, 5dk)` üzerine `±%20` jitter.
Jitter olmadan tüm işler aynı anda uyanır ve ikinci bir 429 dalgası üretir.

**Devre kesici (circuit breaker):** 60 saniyelik pencerede bir tenant için 10'dan fazla
geçici hata varsa o tenant 5 dakika duraklatılır. Diğer müşteriler etkilenmez.

**Dead letter her zaman bir insana görünür.** Sessizce atlanan ürün yok; `dead_letters`
tablosu `GET /health/dead-letters` ucundan ve günlük özet e-postasından okunur.

Uygulama: `src/core/errors.js`, `src/core/retry.js`, `src/core/circuitBreaker.js`

---

## 8. Mutabakat (reconcile)

15 dakikada bir:

1. `GET /retailer/offers?last-modified-date-time=<son tur>&page-size=100` + cursor döngüsü
2. Gelen her offer için `bol_stock`, `bol_corrected_stock`, `bol_price`,
   `bol_last_modified` yazılır
3. `pushed_* != bol_*` olan satırlar **sapma** olarak işaretlenir ve yeniden kuyruğa girer
4. `bol_corrected_stock = 0` ama `desired_stock > 0` olan satırlar ayrı raporlanır —
   bunlar vitrinde görünmeyen ama bizce stokta olan ürünlerdir, doğrudan ciro kaybı

CSV export (`POST /retailer/offers/export`) yalnızca **ilk içe aktarmada** kullanılır:
saatte 9 istek sınırı onu periyodik iş için uygunsuz kılıyor.

Günde bir kez `last-modified` filtresi olmadan tam tarama yapılır.

---

## 9. Konfigürasyon

Tüm ayarlar `.env` üzerinden; örnek `.env.example` dosyasında.
Kimlik bilgileri veritabanında `BOL_CRED_ENC_KEY` ile AES-256-GCM şifreli durur,
log'a asla düz yazılmaz (`src/bol/client.js` içindeki redaksiyon).

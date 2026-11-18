# Bol.com API — doğrulanmış notlar

Kaynak: canlı OpenAPI ve dokümantasyon, çekim tarihi **18.11.2026**.
Hiçbir satır hafızadan yazılmadı; her madde aşağıdaki URL'lerden alındı.

| Ne | URL |
|---|---|
| Retailer API v10 spec | `https://api.bol.com/retailer/public/apispec/Retailer%20API%20-%20v10` |
| Offers API v11 spec | `https://api.bol.com/registry/api-definitions/offers/offers-v11.yaml` |
| Process Status v10 spec | `https://api.bol.com/registry/api-definitions/process-status/process-status-v10.yaml` |
| Canlı rate limit listesi (JSON) | `https://api.bol.com/retailer/public/ratelimits` |
| Kimlik doğrulama | `https://api.bol.com/retailer/public/Retailer-API/authentication.html` |
| Konvansiyonlar (429, başlıklar) | `https://api.bol.com/retailer/public/Retailer-API/conventions.html` |

---

## 1. Kimlik doğrulama

- `POST https://login.bol.com/token?grant_type=client_credentials`
- `Authorization: Basic base64(clientId:clientSecret)`
- `Content-Type: application/x-www-form-urlencoded`, `Accept: application/json`
- Cevap: `{ access_token, token_type: "Bearer", expires_in: 299, scope }`
- **299 saniye.** Doküman açıkça uyarıyor: her istek için yeni token alma, IP ban sebebi.
  → Token tek yerde tutulur, 240. saniyede yenilenir, eşzamanlı yenileme tek uçuşa (single-flight) indirilir.

## 2. Stok ve fiyat güncelleme — iki nesil var

### v11 Offers API (yeni, tercih edilen)

Sürüm `11.5.0`. **Senkron çalışır** — process status mekanizması gerekmiyor.

| Metot | Uç | Cevap |
|---|---|---|
| GET | `/retailer/offers` | 200 + sayfalı liste |
| POST | `/retailer/offers` | **201** + `offerId` |
| GET | `/retailer/offers/{offer-id}` | 200 |
| PATCH | `/retailer/offers/{offer-id}` | **204** |
| DELETE | `/retailer/offers/{offer-id}` | 204 |
| GET | `/retailer/offers/{offer-id}/not-for-sale-reasons` | 200 |

- Accept / Content-Type: `application/vnd.retailer.v11+json`
- `GET /retailer/offers` filtreleri: `offer-ids`, `eans`, `reference`, `for-sale`,
  `last-modified-date-time` (ISO 8601 UTC), `page-size` (1–100), `cursor`.
  → **Cursor tabanlı sayfalama.** `page.nextCursor` null olana kadar dönülür.
- `PATCH` gövdesi kısmi: `pricing`, `stock`, `fulfilment`, `onHoldByRetailer`,
  `reference`, `countryAvailabilities`, `economicOperatorId`, `unknownProductTitle`.
  Stok ve fiyat **tek istekte** güncellenir.
- `offerId` artık UUID.

v11'in v10'a göre getirdikleri (resmî "what's new" sayfası): senkron işleme,
sayfalı offer listesi, PATCH ile kısmi güncelleme, refurbished desteği,
NL+BE çoklu ülke tek offer, offline sebebi için ayrı uç.

### v10 Retailer API (eski, yedek adaptör)

| Metot | Uç | Cevap |
|---|---|---|
| PUT | `/retailer/offers/{offer-id}/stock` | **202** + ProcessStatus |
| PUT | `/retailer/offers/{offer-id}/price` | **202** + ProcessStatus |
| PUT | `/retailer/offers/{offer-id}` | 202 + ProcessStatus |
| POST | `/retailer/offers/export` | 202 (CSV rapor talebi) |
| GET | `/retailer/offers/export/{report-id}` | 200 CSV |

- Accept / Content-Type: `application/vnd.retailer.v10+json`
- 202 dönüyor, **iş bitmiş değil**. `processStatusId` ile
  `GET /shared/process-status/{id}` sorgulanır.
  Durumlar: `PENDING | SUCCESS | FAILURE | TIMEOUT`.
- Toplu sorgu: `POST /shared/process-status`, tek istekte en fazla **1000** id.
- İlgili event tipleri: `UPDATE_OFFER_STOCK`, `UPDATE_OFFER_PRICE`, `UPDATE_OFFER`,
  `CREATE_OFFER`, `DELETE_OFFER`, `CREATE_OFFER_EXPORT`.
- **Uyarı:** process status kayıtları kalıcı değil. Süre dolunca 404 döner;
  polling durdurulmalı, yoksa sonsuz döngü olur.

## 3. Veri şekilleri

### stock
```json
{ "amount": 6, "managedByRetailer": true }
```
- v10'da `amount` sınırı **0–999** (spec'te `minimum: 0, maximum: 999`). v11'de üst sınır
  belirtilmemiş; yine de 999'da kırpıyoruz.
- `managedByRetailer` semantiği (resmî açıklama):
  - `false` → bol, **tüm açık siparişleri** düşerek düzeltilmiş stoğu kendi hesaplar.
  - `true` → yalnızca **son offer güncellemesinden sonraki** siparişler hesaba katılır.
  - Kural: bol siparişleri kaynak sisteme (webshop/ERP) geri yazılıyorsa `true`,
    yazılmıyorsa `false`. Yanlış seçim doğrudan fazla satışa (oversell) yol açar.
- `correctedStock` yalnızca okumada gelir: açık siparişler düşüldükten sonra kalan.
  **Satışı belirleyen bu alandır**; 0 olunca ürün vitrinden düşer.
  Bizim gönderdiğimiz `amount` ile karıştırılmamalı.

### pricing
```json
{ "bundlePrices": [ { "quantity": 1, "unitPrice": 9.99 } ] }
```
- Dizide `quantity: 1` olan eleman **zorunlu**, en fazla 4 eleman.
- `unitPrice`: KDV **dahil**, `minimum: 1`, `maximum: 9999`, iki ondalık, nokta ayraçlı.
- Birden fazla kademe varsa `quantity` artan, `unitPrice` azalan sırada olmalı.

## 4. Rate limit — canlı listeden alınan gerçek değerler

| Uç | Metot | Limit |
|---|---|---|
| `/retailer/offers/**` | GET, POST, PATCH, DELETE | **50 / saniye** |
| `/retailer/offers*` | GET (liste) | **25 / saniye** |
| `/retailer/offers/*/stock` | PUT (v10) | 50 / saniye |
| `/retailer/offers/*/price` | PUT (v10) | 50 / saniye |
| `/retailer/offers/export` | POST | **9 / saat** |
| `/retailer/offers/export/*` | GET | 9 / saat |
| `/shared/process-status/*` | GET | 100 / saniye |
| `/shared/process-status` | GET, POST (toplu) | **2 / saniye** |
| `/retailer/orders` | GET | 25 / dakika |
| `/retailer/orders/*` | GET | 25 / saniye |
| `/retailer/inventory` | GET | 20 / dakika |

Başlıklar (konvansiyon sayfası):
- Limit aşılmadıysa: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`
- Aşıldıysa: **429** + `Retry-After: <saniye>` ve gövdede
  `{ "title": "Too Many Requests", "status": 429, "detail": "..." }`

Tasarım sonuçları:
1. CSV export **saatte 9** — ilk içe aktarma dışında kullanılmaz.
   Mutabakat (reconcile) için v11 `GET /retailer/offers` + `last-modified-date-time` kullanılır.
2. Limitler **satıcı hesabı başına**dır, uygulama başına değil. Müşterinin başka bir aracı
   (repricer, ERP) varsa aynı kovayı paylaşıyoruz. Varsayılan bütçe: limitin **%60**'ı.
3. 403 bile "retryable" olarak işaretli (konvansiyon tablosu), 400 değil.

## 5. Hata kodları (resmî tabloya göre)

| Kod | Yeniden denenir mi | Bizim davranışımız |
|---|---|---|
| 400 | Hayır | Kalıcı hata → dead letter, SKU işaretlenir |
| 401 | Hayır | Token bir kez yenilenir, istek bir kez tekrarlanır |
| 403 | **Evet** | Backoff ile tekrar; 3 kez üst üste ise tenant devre dışı |
| 404 | Hayır | Offer silinmiş → `offer_id` temizlenir, EAN'den yeniden çözülür |
| 409 | — | Offer yeniden okunur, plan yeniden hesaplanır, bir kez tekrar |
| 429 | Evet | `Retry-After` aynen uygulanır, kova boşaltılır |
| 5xx | Evet | Üstel backoff + jitter, en fazla 6 deneme |

---

## 6. Demo ortamı — var, ama sandığın gibi değil

18.11.2026'da doğrulandı. İki bağımsız kanıt:

**Yol testi.** Uydurma ön ekler `403` döndürüyor, demo ön ekleri `401` (kimlik doğrulama
istiyor) — yani yollar gerçek ve yönlendirilmiş durumda.

```
401  https://api.bol.com/retailer-demo/offers
401  https://api.bol.com/shared-demo/process-status/1
403  https://api.bol.com/retailer-xyzzy/offers      <- uydurma
403  https://api.bol.com/nonsense/offers            <- uydurma
```

**Resmî spec.** v10 spec'inin kendi `info.description` alanı demo ortamını adıyla
anlatıyor ve iki doküman veriyor:
- [Demo environment](https://api.bol.com/retailer/public/Retailer-API/demo/demo.html)
- [Demo scenarios v10](https://api.bol.com/retailer/public/Retailer-API/demo/v10-index.html)
  — 16 uç grubu listeli: Commissions, Insights, Inventory, Invoices, Offers, Orders,
  Process Status, Products, Promotions, Replenishments, Retailers, Returns, Shipments,
  Shipping Labels, Subscriptions, Transports.

### Ne veriyor

| Özellik | Durum |
|---|---|
| Kimlik doğrulama | Üretimdekiyle **aynı** çalışıyor |
| Her uç için örnek cevap | Var, **sabit kodlanmış** |
| Doğrulama ve modeller | Üretimin **güncel** sürümüyle aynı |
| Rate limit başlıkları | Var |

### Ne vermiyor — üç sert sınır

1. **Durum tutmuyor.** Bol'un kendi cümlesi: *"updates will return a process status
   entity, but this is a mocked instance so no actual updates are being processed."*
   Yazdığın stok hiçbir yere yazılmıyor, geri okuduğunda değişmemiş oluyor.
   Sabit kodlanmış cevaplar yalnızca **dokümanda tarif edilen belirli isteklere**
   dönüyor; uçtan uca bir akış yok.
2. **Tek bir genel rate limit** var, uç başına değil. Yani §4'teki limit tablosunu
   demo ortamda test edemezsin.
3. **CI/CD'ye bağlanması önerilmiyor**, performans testine de uygun değil.

### Kimlik bilgisi nereden geliyor — asıl kısıt bu

Demo ortamı da dahil her şey **Seller Dashboard (SDD)** üzerinden alınan Client ID +
Client Secret istiyor. Self-servis geliştirici anahtarı **yok**. Yani bol.com satıcı
hesabı olmadan demo ortamına bile giremiyorsun.

Yol: `SDD → hesap profili → Instellingen → Diensten → API Instellingen`.
Önce **teknik iletişim bilgisi** zorunlu — doldurulmazsa API erişimi verilmiyor, ve
Bol ulaşamazsa API yasağı uygulanabiliyor.

Panelde iki bölüm var:

| Bölüm | Ne işe yarıyor |
|---|---|
| **Client Credentials** | Satıcının kendi oluşturduğu anahtarlar |
| **Authorized parties** | Entegrasyon partnerlerine verilen anahtarlar |

**Pratik sonuç — entegrasyonun tasarımı buna göre.** Servisin kendi satıcı hesabı
olmasına gerek yok: mağaza sahibi kendi panelinde **servise özel bir anahtar çifti**
oluşturup veriyor. Bol'un kendi tavsiyesi de bu — *"Create separate credentials for
separate purposes. Do not reuse the same credentials for your own app(s) to grant
access to anyone else."* Erişim çöp kutusu simgesine basarak tek tıkla geri alınıyor.

Yani servis hiçbir zaman mağazanın şifresini görmüyor ve verilen erişim her an
iptal edilebiliyor. Bu, entegrasyonun güvenlik modelinin tamamı.

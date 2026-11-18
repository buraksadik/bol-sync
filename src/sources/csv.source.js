/**
 * CSV / XML supplier feed source.
 *
 * Dutch dropshipping suppliers mostly hand out a URL to a CSV or XML file,
 * refreshed a few times a day.
 *
 * The rules that keep this from causing damage:
 *   - A feed that fails to download is not an empty feed. Keep the previous
 *     snapshot and let it go stale; never interpret a 404 as zero stock.
 *   - A feed whose row count dropped sharply since last time is suspect. Hold it
 *     and raise a review instead of applying it.
 *   - Decimal comma is the Dutch default: "12,95" is a price, not a list.
 */

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { SourceError } from '../core/errors.js';

/** @typedef {import('./source.interface.js').Source} Source */
/** @typedef {import('./source.interface.js').SourceItem} SourceItem */

/** Below this share of parseable data rows the column map or delimiter is wrong. */
const MIN_PARSEABLE_RATIO = 0.5;

/**
 * @param {object} config
 * @param {string} config.path            local path or https URL
 * @param {'csv'|'xml'} [config.format]
 * @param {string} [config.delimiter]     ';' is more common than ',' in NL feeds
 * @param {Record<string,string>} config.columnMap  { sku, ean, stock, price }
 * @param {number} [config.minRowRatio]   hold the feed below this share of the last run
 * @param {string} [config.rowElement]    xml only: the repeating element, e.g. 'product'
 * @param {number} [config.timeoutMs]
 * @returns {Source}
 */
export function createCsvSource(config) {
  if (!config?.path) throw new SourceError('CSV_SOURCE_PATH_MISSING');
  if (!config.columnMap?.sku) throw new SourceError('CSV_SOURCE_COLUMN_MAP_SKU_MISSING');

  const format = config.format ?? 'csv';
  const minRowRatio = config.minRowRatio ?? 0.8;

  /** Row count of the last accepted run, for the drop guard. */
  let lastRowCount = 0;

  async function load() {
    const text = await fetchFeed(config.path, config.timeoutMs ?? 30000);
    const items = format === 'xml' ? parseXml(text, config) : parseCsv(text, config);

    const guard = rowCountGuard(items.length, lastRowCount, minRowRatio);
    if (!guard.ok) {
      // Deliberately a throw, not an empty array. The caller keeps the previous
      // snapshot and lets it go stale, which the planner then refuses to use.
      throw new SourceError(
        `FEED_ROW_COUNT_DROPPED: ${items.length} rows now vs ${lastRowCount} last ` +
          `(ratio ${guard.ratio.toFixed(2)}, minimum ${minRowRatio})`,
      );
    }
    lastRowCount = items.length;
    return items;
  }

  return {
    name: `${format}:${safeName(config.path)}`,

    async fetchAll() {
      return load();
    },

    async fetchBySku(skus) {
      // A flat file has no partial read. Pull it once and filter in memory;
      // that is still one request, which is what the rate budget cares about.
      const wanted = new Set(skus);
      const items = await load();
      return items.filter((i) => wanted.has(i.sku));
    },

    parseWebhook() {
      throw new SourceError('CSV_SOURCE_HAS_NO_WEBHOOK');
    },
  };
}

/**
 * Download or read the feed. Any failure throws; nothing here ever returns an
 * empty feed, because an empty feed means "everything is out of stock".
 *
 * @param {string} path
 * @param {number} timeoutMs
 * @returns {Promise<string>}
 */
async function fetchFeed(path, timeoutMs) {
  if (!/^https?:\/\//i.test(path)) {
    try {
      return await readFile(path, 'utf8');
    } catch (err) {
      throw new SourceError(`FEED_READ_FAILED: ${path} (${/** @type {Error} */ (err).message})`);
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(path, { signal: controller.signal });
    if (!res.ok) {
      throw new SourceError(`FEED_HTTP_${res.status}: ${path}`);
    }
    const text = await res.text();
    if (text.trim().length === 0) throw new SourceError(`FEED_EMPTY: ${path}`);
    return text;
  } catch (err) {
    if (err instanceof SourceError) throw err;
    throw new SourceError(`FEED_FETCH_FAILED: ${path} (${/** @type {Error} */ (err).message})`);
  } finally {
    clearTimeout(timer);
  }
}

/** @param {string} path */
function safeName(path) {
  try {
    return /^https?:\/\//i.test(path) ? new URL(path).hostname : basename(path);
  } catch {
    return 'feed';
  }
}

/**
 * Split one CSV line into fields, honouring quotes and doubled quotes.
 * `split(delimiter)` is wrong the moment a product title contains the delimiter,
 * which in Dutch feeds it does ("Boormachine, 18V").
 *
 * @param {string} line
 * @param {string} delimiter
 * @returns {string[]}
 */
export function splitCsvLine(line, delimiter) {
  /** @type {string[]} */
  const out = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      out.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out.map((f) => f.trim());
}

/**
 * Guess the delimiter from the header line. Dutch feeds use ';' far more often
 * than ',' because Excel in a Dutch locale writes ';'.
 *
 * @param {string} headerLine
 * @returns {string}
 */
export function detectDelimiter(headerLine) {
  const candidates = [';', ',', '\t', '|'];
  let best = ';';
  let bestCount = -1;
  for (const d of candidates) {
    const count = splitCsvLine(headerLine, d).length;
    if (count > bestCount) {
      bestCount = count;
      best = d;
    }
  }
  return best;
}

/**
 * @param {string} text
 * @param {object} config
 * @returns {SourceItem[]}
 */
export function parseCsv(text, config) {
  const clean = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const lines = clean.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length < 2) throw new SourceError('FEED_HAS_NO_DATA_ROWS');

  const delimiter = config.delimiter ?? detectDelimiter(lines[0]);
  const header = splitCsvLine(lines[0], delimiter).map((h) => h.toLowerCase());

  const idx = {};
  for (const [field, column] of Object.entries(config.columnMap)) {
    const position = header.indexOf(String(column).toLowerCase());
    if (position === -1 && (field === 'sku' || field === 'stock' || field === 'price')) {
      throw new SourceError(
        `FEED_COLUMN_NOT_FOUND: "${column}" for ${field}. Header is: ${header.join(delimiter)}`,
      );
    }
    idx[field] = position;
  }

  const observedAt = new Date();
  /** @type {SourceItem[]} */
  const items = [];
  let rejected = 0;

  for (let i = 1; i < lines.length; i += 1) {
    const cells = splitCsvLine(lines[i], delimiter);
    try {
      items.push(rowToItem(cells, idx, observedAt));
    } catch {
      rejected += 1;
    }
  }

  const dataRows = lines.length - 1;
  if (items.length / dataRows < MIN_PARSEABLE_RATIO) {
    throw new SourceError(
      `FEED_MOSTLY_UNPARSEABLE: ${rejected} of ${dataRows} rows rejected. ` +
        `Check the delimiter ("${delimiter}") and the column map.`,
    );
  }
  return items;
}

/**
 * @param {string[]} cells
 * @param {Record<string, number>} idx
 * @param {Date} observedAt
 * @returns {SourceItem}
 */
function rowToItem(cells, idx, observedAt) {
  const sku = (cells[idx.sku] ?? '').trim();
  if (!sku) throw new SourceError('ROW_SKU_EMPTY');

  const eanRaw = idx.ean >= 0 ? (cells[idx.ean] ?? '').trim() : '';
  return {
    sku,
    ean: eanRaw || null,
    stock: Math.max(0, Math.trunc(parseDutchNumber(cells[idx.stock]))),
    price: parseDutchNumber(cells[idx.price]),
    observedAt,
  };
}

/**
 * Minimal XML feed reader for the flat shape Dutch suppliers actually publish:
 *
 *   <products><product><sku>A1</sku><voorraad>7</voorraad></product>...</products>
 *
 * Limits, on purpose: no namespaces, no nested repeating elements, no values in
 * attributes. Anything more complex needs a real parser as a dependency, and
 * that decision belongs to the feed that forces it, not to this file.
 *
 * @param {string} text
 * @param {object} config
 * @returns {SourceItem[]}
 */
export function parseXml(text, config) {
  const row = config.rowElement ?? guessRowElement(text);
  if (!row) throw new SourceError('FEED_XML_ROW_ELEMENT_UNKNOWN: pass config.rowElement');

  const blocks = text.match(new RegExp(`<${row}[\\s>][\\s\\S]*?</${row}>`, 'gi')) ?? [];
  if (blocks.length === 0) throw new SourceError(`FEED_XML_NO_ROWS: <${row}>`);

  const observedAt = new Date();
  /** @type {SourceItem[]} */
  const items = [];
  let rejected = 0;

  for (const block of blocks) {
    try {
      const sku = xmlValue(block, config.columnMap.sku);
      if (!sku) throw new SourceError('ROW_SKU_EMPTY');
      items.push({
        sku,
        ean: config.columnMap.ean ? xmlValue(block, config.columnMap.ean) || null : null,
        stock: Math.max(0, Math.trunc(parseDutchNumber(xmlValue(block, config.columnMap.stock)))),
        price: parseDutchNumber(xmlValue(block, config.columnMap.price)),
        observedAt,
      });
    } catch {
      rejected += 1;
    }
  }

  if (items.length / blocks.length < MIN_PARSEABLE_RATIO) {
    throw new SourceError(
      `FEED_MOSTLY_UNPARSEABLE: ${rejected} of ${blocks.length} <${row}> elements rejected.`,
    );
  }
  return items;
}

/** @param {string} text */
function guessRowElement(text) {
  const counts = new Map();
  for (const m of text.matchAll(/<([A-Za-z_][\w.-]*)[\s>]/g)) {
    const tag = m[1].toLowerCase();
    counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  let best = null;
  let bestCount = 1;
  for (const [tag, count] of counts) {
    if (count > bestCount) {
      bestCount = count;
      best = tag;
    }
  }
  return best;
}

/**
 * @param {string} block
 * @param {string} tag
 * @returns {string}
 */
function xmlValue(block, tag) {
  const m = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'));
  if (!m) return '';
  return decodeXml(m[1].replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1')).trim();
}

/** @param {string} s */
function decodeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

/**
 * Parse a number written the Dutch way: "1.234,95" -> 1234.95
 *
 * An unreadable cell throws. It is never silently zero: a cell that reads as 0
 * stock when it actually means "unknown" is how a catalogue goes offline, and a
 * cell that reads as 0 price is how a catalogue gets sold for nothing.
 *
 * @param {string} raw
 * @returns {number}
 */
export function parseDutchNumber(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  const s = String(raw ?? '')
    .replace(/[\s  ]/g, '')
    .replace(/[€$£]/g, '')
    .trim();

  if (s === '') throw new SourceError('NUMBER_EMPTY');

  const hasDot = s.includes('.');
  const hasComma = s.includes(',');
  let normalised;

  if (hasDot && hasComma) {
    // Whichever separator comes last is the decimal one.
    normalised =
      s.lastIndexOf(',') > s.lastIndexOf('.')
        ? s.replace(/\./g, '').replace(',', '.')
        : s.replace(/,/g, '');
  } else if (hasComma) {
    normalised = s.replace(',', '.');
  } else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) {
    // "1.234" and "1.234.567" are thousands, not decimals.
    normalised = s.replace(/\./g, '');
  } else {
    normalised = s;
  }

  const n = Number(normalised);
  if (!Number.isFinite(n)) throw new SourceError(`NUMBER_UNPARSEABLE: ${raw}`);
  return n;
}

/**
 * @param {number} rowsNow
 * @param {number} rowsLast
 * @param {number} minRatio
 * @returns {{ ok: boolean, ratio: number }}
 */
export function rowCountGuard(rowsNow, rowsLast, minRatio) {
  if (rowsLast === 0) return { ok: true, ratio: 1 };
  const ratio = rowsNow / rowsLast;
  return { ok: ratio >= minRatio, ratio };
}

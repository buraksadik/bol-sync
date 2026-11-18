import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseDutchNumber,
  splitCsvLine,
  detectDelimiter,
  parseCsv,
  parseXml,
  rowCountGuard,
} from '../src/sources/csv.source.js';
import { hashItem } from '../src/sources/source.interface.js';
import { SourceError } from '../src/core/errors.js';

test('parseDutchNumber reads the Dutch decimal comma', () => {
  assert.equal(parseDutchNumber('12,95'), 12.95);
  assert.equal(parseDutchNumber('1.234,95'), 1234.95);
  assert.equal(parseDutchNumber('€ 1.234,95'), 1234.95);
  assert.equal(parseDutchNumber('7'), 7);
  assert.equal(parseDutchNumber('-3,5'), -3.5);
});

test('parseDutchNumber reads the English thousands separator too', () => {
  // Some suppliers export with an English locale. Last separator wins.
  assert.equal(parseDutchNumber('1,234.95'), 1234.95);
});

test('parseDutchNumber treats a bare dot group as thousands', () => {
  assert.equal(parseDutchNumber('1.234'), 1234);
  assert.equal(parseDutchNumber('1.234.567'), 1234567);
  // but a two-decimal dot is a decimal point
  assert.equal(parseDutchNumber('12.95'), 12.95);
});

test('parseDutchNumber refuses an empty or unreadable cell', () => {
  // The whole point: an unknown stock must never silently become 0.
  assert.throws(() => parseDutchNumber(''), SourceError);
  assert.throws(() => parseDutchNumber('   '), SourceError);
  assert.throws(() => parseDutchNumber('op aanvraag'), SourceError);
});

test('splitCsvLine survives a delimiter inside a quoted field', () => {
  const line = 'A1;"Boormachine, 18V";7;"12,95"';
  assert.deepEqual(splitCsvLine(line, ';'), ['A1', 'Boormachine, 18V', '7', '12,95']);
});

test('splitCsvLine unescapes a doubled quote', () => {
  assert.deepEqual(splitCsvLine('A1;"13"" scherm";1', ';'), ['A1', '13" scherm', '1']);
});

test('detectDelimiter prefers the separator that yields most fields', () => {
  assert.equal(detectDelimiter('sku;ean;voorraad;prijs'), ';');
  assert.equal(detectDelimiter('sku,ean,voorraad,prijs'), ',');
});

const columnMap = { sku: 'sku', ean: 'ean', stock: 'voorraad', price: 'prijs' };

test('parseCsv handles BOM, CRLF and Dutch prices', () => {
  const text =
    '﻿sku;ean;voorraad;prijs\r\n' +
    'A1;8712345678901;7;12,95\r\n' +
    'A2;8712345678902;0;1.234,50\r\n';
  const items = parseCsv(text, { columnMap });

  assert.equal(items.length, 2);
  assert.deepEqual(
    { ...items[0], observedAt: undefined },
    { sku: 'A1', ean: '8712345678901', stock: 7, price: 12.95, observedAt: undefined },
  );
  assert.equal(items[1].stock, 0);
  assert.equal(items[1].price, 1234.5);
});

test('parseCsv drops a single bad row but keeps the feed', () => {
  const text =
    'sku;ean;voorraad;prijs\n' +
    'A1;8712345678901;7;12,95\n' +
    ';8712345678902;3;9,95\n' + // no sku
    'A3;;op aanvraag;9,95\n' + // unreadable stock
    'A4;;2;9,95\n';
  const items = parseCsv(text, { columnMap });
  assert.deepEqual(items.map((i) => i.sku), ['A1', 'A4']);
});

test('parseCsv refuses a feed where the column map does not match', () => {
  const text = 'artikelnr;aantal;bedrag\nA1;7;12,95\n';
  assert.throws(() => parseCsv(text, { columnMap }), /FEED_COLUMN_NOT_FOUND/);
});

test('parseCsv refuses a feed that is mostly unparseable', () => {
  // Wrong delimiter: every row collapses into one field.
  const text = 'sku;ean;voorraad;prijs\nA1;1;7;12,95\nA2;2;7;12,95\nA3;3;x;y\nA4;4;x;y\nA5;5;x;y\n';
  assert.throws(() => parseCsv(text, { columnMap }), /FEED_MOSTLY_UNPARSEABLE/);
});

test('parseCsv refuses a file with no data rows', () => {
  assert.throws(() => parseCsv('sku;voorraad;prijs\n', { columnMap }), /FEED_HAS_NO_DATA_ROWS/);
});

test('parseXml reads a flat supplier feed', () => {
  const xml = `<?xml version="1.0"?>
    <producten>
      <product><sku>A1</sku><ean>871234</ean><voorraad>7</voorraad><prijs>12,95</prijs></product>
      <product><sku><![CDATA[A2]]></sku><ean></ean><voorraad>0</voorraad><prijs>9,95</prijs></product>
    </producten>`;
  const items = parseXml(xml, { rowElement: 'product', columnMap });

  assert.equal(items.length, 2);
  assert.equal(items[0].sku, 'A1');
  assert.equal(items[0].price, 12.95);
  assert.equal(items[1].sku, 'A2');
  assert.equal(items[1].ean, null);
});

test('parseXml decodes entities', () => {
  const xml =
    '<r><p><sku>A&amp;B</sku><voorraad>1</voorraad><prijs>1,00</prijs></p></r>';
  const items = parseXml(xml, { rowElement: 'p', columnMap });
  assert.equal(items[0].sku, 'A&B');
});

test('rowCountGuard holds a feed that shrank', () => {
  assert.deepEqual(rowCountGuard(100, 100, 0.8), { ok: true, ratio: 1 });
  assert.equal(rowCountGuard(40, 100, 0.8).ok, false);
  // first run has nothing to compare against
  assert.equal(rowCountGuard(10, 0, 0.8).ok, true);
});

test('hashItem ignores observedAt', () => {
  const base = { sku: 'A1', ean: '871', stock: 7, price: 12.95 };
  const a = hashItem({ ...base, observedAt: new Date('2026-11-18T08:00:00Z') });
  const b = hashItem({ ...base, observedAt: new Date('2026-11-18T09:00:00Z') });
  assert.equal(a, b, 'a new poll time must not invalidate the hash');

  const c = hashItem({ ...base, stock: 6, observedAt: new Date() });
  assert.notEqual(a, c);
});

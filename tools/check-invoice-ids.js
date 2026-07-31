#!/usr/bin/env node
/**
 * Checks invoice ID generation and ordering.
 *
 *   node tools/check-invoice-ids.js
 *
 * IDs are <business prefix><MMYY><suffix>, e.g. AT0526, AT0526a. The prefix
 * comes from the business's invoice_code, or the initials of its name.
 *
 * The awkward parts, all covered below:
 *   - Numbering is per business per month, so two clients in the same month
 *     both start unsuffixed.
 *   - Sheets coerces a bare '0526' to the number 526, so the old prefix-less
 *     IDs must still be recognised and still sort correctly.
 *   - MMYY cannot be compared numerically: 0526 (May 2026) is a smaller number
 *     than 0625 (June 2025) but a later date.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

// --- Server: prefix derivation + id generation ---

const srv = { Logger: { log: function() {} } };
vm.createContext(srv);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/server/InvoiceService.gs'), 'utf8'),
  srv, { filename: 'invoice-service.js' });

let invoices = [];
const businesses = [
  { business_id: 'BIZ-001', name: 'Auckland Transport' },
  { business_id: 'BIZ-002', name: 'Beta Corp Limited' },
  { business_id: 'BIZ-003', name: 'Acme', invoice_code: '' },
  { business_id: 'BIZ-004', name: 'Ministry of Business and Employment' },
  { business_id: 'BIZ-005', name: "Bob's Bakery" },
  { business_id: 'BIZ-006', name: 'Air Traffic', invoice_code: 'atc' },
  { business_id: 'BIZ-007', name: '   ' }
];

Object.assign(srv, {
  withScriptLock: function(fn) { return fn(); },
  // Real implementation is in SheetService.gs, which is not loaded here.
  dateOnly: function(val) {
    if (!val) return '';
    if (val instanceof Date) {
      var y = val.getFullYear();
      var m = String(val.getMonth() + 1).padStart(2, '0');
      var d = String(val.getDate()).padStart(2, '0');
      return y + '-' + m + '-' + d;
    }
    var s = String(val);
    var match = s.match(/^(\d{4}-\d{2}-\d{2})/);
    return match ? match[1] : '';
  },
  idsMatch: function(a, b) {
    var x = String(a), y = String(b);
    return x === y || (x.replace(/^0+/, '') === y.replace(/^0+/, '') && x !== '' && y !== '');
  },
  getAll: function(n) { return n === 'Invoices' ? invoices.slice() : []; },
  findById: function(n, id) {
    if (n !== 'Businesses') return null;
    return businesses.find(function(b) { return b.business_id === id; }) || null;
  }
});

// --- Client: id parsing + sorting ---

const cli = { console: console };
vm.createContext(cli);
const budgetSrc = /<script[^>]*>([\s\S]*?)<\/script>/
  .exec(fs.readFileSync(path.join(ROOT, 'src/client/js/budget.js.html'), 'utf8'))[1];
const utilsSrc = /<script[^>]*>([\s\S]*?)<\/script>/
  .exec(fs.readFileSync(path.join(ROOT, 'src/client/js/utils.js.html'), 'utf8'))[1];
vm.runInContext(utilsSrc + '\n' + budgetSrc, cli, { filename: 'budget-client.js' });

// --- Harness ---

let failures = 0;
let passes = 0;

function check(label, fn) {
  try {
    fn();
    passes++;
    console.log('  ok    ' + label);
  } catch (e) {
    failures++;
    console.log('  FAIL  ' + label);
    console.log('        ' + e.message);
  }
}

function eq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error((msg ? msg + ': ' : '') + 'expected ' + JSON.stringify(expected) +
      ', got ' + JSON.stringify(actual));
  }
}

function throws(fn, fragment) {
  let threw = null;
  try { fn(); } catch (e) { threw = e; }
  if (!threw) throw new Error('expected a throw, got none');
  if (fragment && threw.message.indexOf(fragment) === -1) {
    throw new Error('expected message containing "' + fragment + '", got "' + threw.message + '"');
  }
}

function prefixOf(id) { return srv.businessInvoicePrefix(businesses.find(function(b) { return b.business_id === id; })); }
/** Issue an invoice and record it the way the sheet would. */
function issue(businessId, dateTo) {
  const id = srv.generateInvoiceId(dateTo, businessId);
  invoices.push({ invoice_id: id, business_id: businessId, date_to: dateTo });
  return id;
}
/** A row already on the sheet, for the pre-existing-data cases. */
function existing(id, businessId, dateTo) {
  return { invoice_id: id, business_id: businessId || '', date_to: dateTo || '' };
}

console.log('\nPrefix derivation');
check('initials of a two-word name', function() { eq(prefixOf('BIZ-001'), 'AT'); });
check('a legal suffix is ignored', function() { eq(prefixOf('BIZ-002'), 'BC', 'Beta Corp Limited'); });
check('single word takes its first two letters', function() { eq(prefixOf('BIZ-003'), 'AC', 'Acme'); });
check('connectives are skipped and the prefix is capped at three', function() {
  eq(prefixOf('BIZ-004'), 'MBE', 'Ministry of Business and Employment');
});
check('punctuation is stripped', function() { eq(prefixOf('BIZ-005'), 'BB', "Bob's Bakery"); });
check('an explicit invoice_code wins and is upper-cased', function() {
  eq(prefixOf('BIZ-006'), 'ATC', 'Air Traffic with code atc');
});
check('a blank name yields no prefix', function() { eq(prefixOf('BIZ-007'), ''); });
check('no business at all yields no prefix', function() {
  eq(srv.businessInvoicePrefix(null), '');
  eq(srv.businessInvoicePrefix({}), '');
});

console.log('\nID generation');
invoices = [];
check('first invoice of the month is unsuffixed', function() {
  eq(issue('BIZ-001', '2026-05-31'), 'AT0526');
});
check('second for the same business and month gets a', function() {
  eq(issue('BIZ-001', '2026-05-20'), 'AT0526a');
});
check('third gets b', function() { eq(issue('BIZ-001', '2026-05-15'), 'AT0526b'); });
check('a different business in the same month starts clean', function() {
  eq(issue('BIZ-002', '2026-05-31'), 'BC0526');
});
check('the same business in a different month starts clean', function() {
  eq(issue('BIZ-001', '2026-06-30'), 'AT0626');
});
check('suffixes are independent per business', function() {
  eq(issue('BIZ-002', '2026-05-01'), 'BC0526a');
  eq(issue('BIZ-001', '2026-05-02'), 'AT0526c');
});
check('no business falls back to bare MMYY, ignoring prefixed ids', function() {
  // Several AT/BC ids exist for 0526 by now; none of them is a bare 0526, so
  // the prefix-less sequence starts fresh rather than being bumped by them.
  eq(srv.generateInvoiceId('2026-05-31'), '0526');
});
check('all-initials names still work', function() {
  eq(srv.businessInvoicePrefix({ name: 'H & M' }), 'HM');
  eq(srv.businessInvoicePrefix({ name: 'A1 Plumbing' }), 'AP');
});

console.log('\nPrefixes never start with a digit');
// normalizeId strips leading zeros from every id it compares, so '0S0526' and
// 'S0526' would alias each other and findById could return the wrong invoice.
check('a leading digit is dropped', function() {
  eq(srv.businessInvoicePrefix({ name: '007 Security Ltd' }), 'S', '007 Security');
  eq(srv.businessInvoicePrefix({ name: '0800 Plumbing' }), 'P', '0800 Plumbing');
  eq(srv.businessInvoicePrefix({ name: '3M' }), 'M', '3M');
  eq(srv.businessInvoicePrefix({ invoice_code: '0AT' }), 'AT', 'explicit code');
});
check('an all-digit code yields no prefix rather than an ambiguous id', function() {
  eq(srv.businessInvoicePrefix({ invoice_code: '0' }), '');
  eq(srv.businessInvoicePrefix({ invoice_code: '24' }), '');
});
check('generated ids therefore never begin with a digit', function() {
  invoices = [];
  const id = srv.generateInvoiceId('2026-05-31', 'BIZ-007X');
  eq(/^[0-9]/.test(id) === false || id === '0526', true,
    'either letter-led or the deliberate prefix-less fallback, got ' + id);
});

console.log('\nExisting prefix-less IDs');
invoices = [existing('0526'), existing('0526a')];
check('a prefixed id is unaffected by existing bare ids', function() {
  eq(srv.generateInvoiceId('2026-05-31', 'BIZ-001'), 'AT0526');
});
check('a prefix-less id continues the old sequence', function() {
  eq(srv.generateInvoiceId('2026-05-31'), '0526b');
});
check('a leading zero stripped by Sheets is still matched', function() {
  invoices = [existing(526)];
  eq(srv.generateInvoiceId('2026-05-31'), '0526a', 'numeric 526 counts as 0526');
});
check('a prefix is not confused with another business', function() {
  invoices = [existing('AT0526', 'BIZ-001', '2026-05-31'),
    existing('ATC0526', 'BIZ-006', '2026-05-31')];
  // 'AT' must not match 'ATC0526', or Air Traffic's invoice would bump
  // Auckland Transport's sequence.
  eq(srv.generateInvoiceId('2026-05-31', 'BIZ-001'), 'AT0526a');
  eq(srv.generateInvoiceId('2026-05-31', 'BIZ-006'), 'ATC0526a');
});

console.log('\nBad period end dates');
check('a Date object is accepted', function() {
  invoices = [];
  eq(srv.generateInvoiceId(new Date(2026, 4, 31), 'BIZ-001'), 'AT0526');
});
check('an ISO timestamp is accepted', function() {
  invoices = [];
  eq(srv.generateInvoiceId('2026-05-31T00:00:00', 'BIZ-001'), 'AT0526');
});
['', null, undefined, 'not-a-date', '31/05/2026'].forEach(function(bad) {
  check('rejects ' + JSON.stringify(bad) + ' instead of inventing an id', function() {
    invoices = [];
    throws(function() { srv.generateInvoiceId(bad, 'BIZ-001'); }, 'not a valid period end date');
  });
});

console.log('\nSuffix rollover');
check('z rolls over to aa, and stays there', function() {
  eq(srv.nextSuffix('z'), 'aa');
  eq(srv.nextSuffix('aa'), 'ab');
  eq(srv.nextSuffix('az'), 'ba');
  eq(srv.nextSuffix('zz'), 'aaa');
});
check('a month past z keeps advancing', function() {
  invoices = [existing('AT0526', 'BIZ-001', '2026-05-31'),
    existing('AT0526z', 'BIZ-001', '2026-05-31')];
  eq(srv.generateInvoiceId('2026-05-31', 'BIZ-001'), 'AT0526aa');
  invoices.push(existing('AT0526aa', 'BIZ-001', '2026-05-31'));
  eq(srv.generateInvoiceId('2026-05-31', 'BIZ-001'), 'AT0526ab');
});

console.log('\nSequencing survives renames and shared prefixes');
check('a rename does not restart the sequence', function() {
  // Numbering counts this business's invoices for the month, so changing the
  // name (and therefore the prefix) cannot produce a second unsuffixed invoice.
  invoices = [existing('AC0526', 'BIZ-003', '2026-05-31'),
    existing('AC0526a', 'BIZ-003', '2026-05-20')];
  businesses.find(function(b) { return b.business_id === 'BIZ-003'; }).name = 'Acme Digital';
  const id = srv.generateInvoiceId('2026-05-31', 'BIZ-003');
  eq(id.slice(0, 2), 'AD', 'new prefix');
  eq(id === 'AD0526', false, 'not a second unsuffixed invoice for the month');
  businesses.find(function(b) { return b.business_id === 'BIZ-003'; }).name = 'Acme';
});
check('a retired number is never reused', function() {
  // a..y were used and deleted; z remains. The next id must go past z, not
  // refill the hole — a client's records may still refer to those numbers.
  invoices = [existing('AT0526', 'BIZ-001', '2026-05-31'),
    existing('AT0526z', 'BIZ-001', '2026-05-30')];
  eq(srv.generateInvoiceId('2026-05-31', 'BIZ-001'), 'AT0526aa');
});
check('suffix positions compare as numbers, not strings', function() {
  eq(srv.suffixIndex(''), 0);
  eq(srv.suffixIndex('a'), 1);
  eq(srv.suffixIndex('z'), 26);
  eq(srv.suffixIndex('aa'), 27);
  eq(srv.suffixIndex('zz'), 702);
  eq(srv.suffixIndex('aaa'), 703);
});
check('an id already on the sheet is never duplicated', function() {
  // Hand-edited row occupying the slot the count would land on.
  invoices = [existing('AT0526', 'BIZ-001', '2026-05-31'),
    existing('AT0526a', 'BIZ-999', '2026-05-31')];
  const id = srv.generateInvoiceId('2026-05-31', 'BIZ-001');
  eq(id === 'AT0526a', false, 'skipped the taken id');
  eq(id, 'AT0526b');
});

console.log('\nParsing and ordering (client)');
check('a prefixed id parses', function() {
  const p = cli.parseInvoiceId('AT0526b');
  eq(p.prefix, 'AT'); eq(p.month, '05'); eq(p.year, '26'); eq(p.suffix, 'b');
});
check('a bare id parses', function() {
  const p = cli.parseInvoiceId('0526');
  eq(p.prefix, ''); eq(p.month, '05'); eq(p.year, '26'); eq(p.suffix, '');
});
check('a zero-stripped id parses', function() {
  const p = cli.parseInvoiceId(526);
  eq(p.month, '05'); eq(p.year, '26');
});
check('a numeric prefix still parses', function() {
  const p = cli.parseInvoiceId('110526');
  eq(p.prefix, '11'); eq(p.month, '05'); eq(p.year, '26');
});
check('unrecognised shapes return null', function() {
  eq(cli.parseInvoiceId(''), null);
  eq(cli.parseInvoiceId('not-an-id'), null);
});
check('an upper-case suffix parses, matching the server scan', function() {
  // generateInvoiceId scans case-insensitively, so the client must not treat
  // the same id as unparsable and fall back to a lexical compare.
  const p = cli.parseInvoiceId('AT0526A');
  eq(!!p, true, 'parsed');
  eq(p.suffix, 'a', 'normalised to lower case');
});
check('the comparator stays transitive with an unparsable id present', function() {
  const odd = 'AT0526-x';
  const ids = [odd, 'AT0625', 'AT0526'];
  // Every permutation must produce the same order, which an intransitive
  // comparator cannot manage.
  const orders = new Set();
  [[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]].forEach(function(perm) {
    orders.add(perm.map(function(i) { return ids[i]; }).sort(cli.sortInvoiceIds).join(','));
  });
  eq(orders.size, 1, 'one stable order across permutations, got ' + Array.from(orders).join(' | '));
  eq(Array.from(orders)[0].indexOf(odd) > 0, true, 'unparsable ids sort last');
});
check('ordering is chronological, not numeric', function() {
  // The old numeric sort put June 2025 (0625) after May 2026 (0526).
  const sorted = ['AT0526', 'AT0625', 'AT1225'].sort(cli.sortInvoiceIds);
  eq(sorted.join(','), 'AT0625,AT1225,AT0526');
});
check('within a month, prefix then suffix orders', function() {
  const sorted = ['AT0526b', 'BC0526', 'AT0526', 'AT0526a', 'AT0526aa', 'AT0526z']
    .sort(cli.sortInvoiceIds);
  eq(sorted.join(','), 'AT0526,AT0526a,AT0526b,AT0526z,AT0526aa,BC0526');
});
check('bare and prefixed ids sort together', function() {
  const sorted = ['AT0526', '0526', '0526a'].sort(cli.sortInvoiceIds);
  eq(sorted.join(','), '0526,0526a,AT0526', 'no prefix sorts before a prefix');
});
check('the sort is stable and total (no comparator contradictions)', function() {
  const ids = ['AT0526', 'AT0526a', 'BC0526', '0526', 'AT0625', 526, 'weird'];
  const sorted = ids.slice().sort(cli.sortInvoiceIds);
  eq(sorted.length, ids.length, 'nothing lost');
  // Re-sorting an already sorted list must not change it.
  eq(sorted.slice().sort(cli.sortInvoiceIds).join('|'), sorted.join('|'), 'idempotent');
});

console.log('\n' + passes + ' passed, ' + failures + ' failed');
process.exit(failures > 0 ? 1 : 0);

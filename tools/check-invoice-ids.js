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

function prefixOf(id) { return srv.businessInvoicePrefix(businesses.find(function(b) { return b.business_id === id; })); }
function issue(businessId, dateTo) {
  const id = srv.generateInvoiceId(dateTo, businessId);
  invoices.push({ invoice_id: id });
  return id;
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
  eq(srv.businessInvoicePrefix({ name: '3M' }), '3M');
});

console.log('\nExisting prefix-less IDs');
invoices = [{ invoice_id: '0526' }, { invoice_id: '0526a' }];
check('a prefixed id is unaffected by existing bare ids', function() {
  eq(srv.generateInvoiceId('2026-05-31', 'BIZ-001'), 'AT0526');
});
check('a prefix-less id continues the old sequence', function() {
  eq(srv.generateInvoiceId('2026-05-31'), '0526b');
});
check('a leading zero stripped by Sheets is still matched', function() {
  invoices = [{ invoice_id: 526 }];
  eq(srv.generateInvoiceId('2026-05-31'), '0526a', 'numeric 526 counts as 0526');
});
check('a prefix is not confused with another business', function() {
  invoices = [{ invoice_id: 'AT0526' }, { invoice_id: 'ATC0526' }];
  // 'AT' must not match 'ATC0526', or Air Traffic's invoice would bump
  // Auckland Transport's sequence.
  eq(srv.generateInvoiceId('2026-05-31', 'BIZ-001'), 'AT0526a');
  eq(srv.generateInvoiceId('2026-05-31', 'BIZ-006'), 'ATC0526a');
});

console.log('\nSuffix rollover');
check('z rolls over to aa, and stays there', function() {
  eq(srv.nextSuffix('z'), 'aa');
  eq(srv.nextSuffix('aa'), 'ab');
  eq(srv.nextSuffix('az'), 'ba');
  eq(srv.nextSuffix('zz'), 'aaa');
});
check('a month past z keeps advancing', function() {
  invoices = [{ invoice_id: 'AT0526' }, { invoice_id: 'AT0526z' }];
  eq(srv.generateInvoiceId('2026-05-31', 'BIZ-001'), 'AT0526aa');
  invoices.push({ invoice_id: 'AT0526aa' });
  eq(srv.generateInvoiceId('2026-05-31', 'BIZ-001'), 'AT0526ab');
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

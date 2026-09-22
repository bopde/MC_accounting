#!/usr/bin/env node
/**
 * End-to-end checks for allocate -> summarise, against an in-memory stand-in
 * for the Sheets layer.
 *
 *   node tools/check-budget-integration.js
 *
 * check-budget-math.js covers the cascade arithmetic. This covers the layer
 * above it: that allocateBudget writes the rows the preview promised, that
 * getBudgetSummary groups them into the shape the Budget page renders, and
 * that pre-company allocations still resolve by label.
 *
 * The stubs below mirror the real SheetService.gs primitives closely enough to
 * catch shape and key mistakes — they are not a substitute for running the app.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

const source = ['BudgetCategories.gs', 'BudgetService.gs']
  .map(function(f) { return fs.readFileSync(path.join(ROOT, 'src', 'server', f), 'utf8'); })
  .join('\n');

const app = { Logger: { log: function() {} } };
vm.createContext(app);
vm.runInContext(source, app, { filename: 'budget-service.js' });

// --- Fixtures ---

const COMPANY_RULE = {
  rule_id: 'BR-001', name: 'Company Default', model: 'company', is_default: true, active: true,
  biz_tax_withheld_pct: 0, biz_acc_withheld_pct: 0,
  biz_tax_pct: 0.28, biz_acc_pct: 0.01, biz_reserve_pct: 0.10,
  per_tax_pct: 0.30, per_acc_pct: 0.0167,
  per_donate_pct: 0.05, per_save_pct: 0.10, per_invest_pct: 0.15, per_spend_pct: 0.70
};

const db = {
  Businesses: [
    { business_id: 'BIZ-001', name: 'Acme', currency: 'NZD', active: true, _rowIndex: 2 }
  ],
  Invoices: [
    { invoice_id: '0526', business_id: 'BIZ-001', created_date: '2026-05-31',
      include_gst: true, gst_rate: 0.15, time_subtotal: 5000, subtotal: 5200,
      gst_amount: 750, total: 5950, status: 'paid', budget_rule_id: '', _rowIndex: 2 },
    { invoice_id: '0425', business_id: 'BIZ-001', created_date: '2026-04-30',
      include_gst: true, gst_rate: 0.15, time_subtotal: 158.73, subtotal: 158.73,
      gst_amount: 23.81, total: 182.54, status: 'paid', budget_rule_id: 'BR-000', _rowIndex: 3 }
  ],
  BudgetRules: [Object.assign({}, COMPANY_RULE, { _rowIndex: 2 })],
  // A pre-company allocation: free-text label, no category_key or scope.
  BudgetAllocations: [
    { allocation_id: 'BA-001', invoice_id: '0425', category: 'Spend', category_key: '',
      scope: '', percentage: 0.7, amount: 111.11, status: 'allocated',
      transfer_date: '', notes: '', _rowIndex: 2 }
  ],
  BudgetPayments: []
};

// --- Sheet layer stubs (mirroring SheetService.gs) ---

let allocationSeq = 1;
let paymentSeq = 0;

Object.assign(app, {
  LockService: {
    getScriptLock: function() { return { waitLock: function() {}, releaseLock: function() {} }; }
  },
  // Real implementation lives in SheetService.gs, which is not loaded here
  // because it is all Google API calls. Single-threaded, so pass-through.
  withScriptLock: function(fn) { return fn(); },
  getByDateParams: function(name, col, params) {
    if (typeof params === 'object' && params !== null) {
      if (!params.dateFrom && !params.dateTo) return app.getAll(name);
      return app.getByDateRange(name, col, params.dateFrom, params.dateTo);
    }
    if (params) return app.getByYear(name, col, params);
    return app.getAll(name);
  },
  isFilteringParams: function(params) {
    if (typeof params === 'object' && params !== null) {
      return !!(params.dateFrom || params.dateTo);
    }
    return !!params;
  },
  getAll: function(name) {
    return (db[name] || []).map(function(r) { return Object.assign({}, r); });
  },
  findById: function(name, id) {
    const rows = db[name] || [];
    const idField = Object.keys(rows[0] || {}).filter(function(k) { return k !== '_rowIndex'; })[0];
    return rows.find(function(r) { return app.idsMatch(r[idField], id); }) || null;
  },
  appendRow: function(name, data) {
    if (name === 'BudgetAllocations') {
      data.allocation_id = 'BA-' + String(++allocationSeq).padStart(3, '0');
    }
    if (name === 'BudgetPayments') {
      data.payment_id = 'BP-' + String(++paymentSeq).padStart(3, '0');
    }
    data._rowIndex = db[name].length + 2;
    db[name].push(Object.assign({}, data));
    return data;
  },
  // Mirrors Sheets: deleting a row shifts every row below it up one.
  deleteRow: function(name, rowIndex) {
    db[name] = db[name].filter(function(r) { return r._rowIndex !== rowIndex; });
    db[name].forEach(function(r, i) { r._rowIndex = i + 2; });
  },
  updateRow: function(name, rowIndex, data) {
    const i = db[name].findIndex(function(r) { return r._rowIndex === rowIndex; });
    if (i >= 0) db[name][i] = Object.assign({}, data);
    return data;
  },
  idsMatch: function(a, b) {
    const sa = String(a), sb = String(b);
    if (sa === sb) return true;
    return sa.replace(/^0+/, '') === sb.replace(/^0+/, '') && sa !== '' && sb !== '';
  },
  normalizeId: function(id) { return String(id).replace(/^0+/, '') || '0'; },
  isTruthy: function(v) { return v === true || v === 'TRUE' || v === 'true'; },
  todayLocal: function() { return '2026-06-01'; },
  dateOnly: function(v) { return (String(v).match(/^(\d{4}-\d{2}-\d{2})/) || ['', ''])[1]; },
  getByDateRange: function(name, col, from, to) {
    return app.getAll(name).filter(function(r) {
      const d = app.dateOnly(r[col]);
      return d && (!from || d >= from) && (!to || d <= to);
    });
  },
  getByYear: function(name, col, year) {
    return app.getAll(name).filter(function(r) {
      return app.dateOnly(r[col]).indexOf(String(year)) === 0;
    });
  }
});

// --- Harness ---

let failures = 0;
let passes = 0;
const r2 = app.round2;

function assert(cond, msg) {
  if (cond) {
    passes++;
    console.log('  ok    ' + msg);
  } else {
    failures++;
    console.log('  FAIL  ' + msg);
  }
}

const RANGE = { dateFrom: '2026-01-01', dateTo: '2026-12-31' };

// --- Preview ---

console.log('\nPreview');
const preview = app.previewAllocation('0526', 'BR-001');
preview.lines.forEach(function(l) {
  console.log('    ' + l.scope.padEnd(9) + l.label.padEnd(15) +
    (l.pct == null ? '—' : (l.pct * 100).toFixed(2) + '%').padStart(7) +
    String(l.amount).padStart(10));
});
assert(preview.total === 5750, 'total equals gross + GST (5750), got ' + preview.total);
assert(preview.currency === 'NZD', 'currency resolved from the business');
assert(preview.model === 'company', 'model reported as company');
assert(preview.stages.ownerPay === 3050, 'Owner Pay is 3050, got ' + preview.stages.ownerPay);

// --- Allocate ---

console.log('\nAllocate');
const written = app.allocateBudget('0526', 'BR-001');
assert(written.length === preview.lines.length,
  'one row written per previewed line (' + written.length + ' vs ' + preview.lines.length + ')');
assert(r2(written.filter(function(w) { return w.category_key !== 'owner_pay'; })
  .reduce(function(s, w) { return s + w.amount; }, 0)) === 5750, 'written rows sum to 5750');
assert(written.every(function(w) { return w.category_key && w.scope; }),
  'every row carries category_key and scope');
assert(db.Invoices[0].budget_rule_id === 'BR-001', 'invoice stamped with the rule used');

let blocked = false;
try {
  app.allocateBudget('0526', 'BR-001');
} catch (e) {
  blocked = /already allocated/.test(e.message);
}
assert(blocked, 'a second allocation of the same invoice is refused');

// --- Summary ---

console.log('\nSummary');
const summary = app.getBudgetSummary(RANGE);
summary.scopes.forEach(function(s) {
  console.log('    ' + s.label + ' — allocated ' + s.allocated.toFixed(2) +
    ', outstanding ' + s.outstanding.toFixed(2));
});
console.log('    accountHoldings: ' + JSON.stringify(summary.accountHoldings));

assert(summary.scopes.map(function(s) { return s.scope; }).join(',') === 'business,bridge,personal,legacy',
  'scopes come back in registry order');
assert(r2(summary.totals.allocated) === r2(5750 + 111.11),
  'totals exclude Owner Pay and include the legacy row, got ' + summary.totals.allocated);
assert(summary.totals.allocationCount === 11,
  'allocation count excludes the Owner Pay transfer, got ' + summary.totals.allocationCount);

const legacyScope = summary.scopes.find(function(s) { return s.scope === 'legacy'; });
assert(legacyScope.categories.length === 1 && legacyScope.categories[0].key === 'legacy_spend',
  'a row with no category_key resolves to its legacy bucket, not the new personal Spend');
assert(summary.accountHoldings.legacy === 111.11,
  'legacy money is kept out of both business and personal holdings');

const businessExpected = r2(750 + 1400 + 50 + 500);
assert(r2(summary.accountHoldings.business) === businessExpected,
  'business holdings = GST + tax + ACC + reserve (' + businessExpected + '), got ' + summary.accountHoldings.business);
assert(summary.bridge.allocated === 3050, 'bridge reports Owner Pay of 3050');

const personalScope = summary.scopes.find(function(s) { return s.scope === 'personal'; });
assert(r2(personalScope.categories.reduce(function(s, c) { return s + c.allocated; }, 0)) === 3050,
  'personal buckets sum back to Owner Pay');
assert(personalScope.categories.every(function(c) { return c.settle && c.key; }),
  'every summary category carries settle + key for the UI');

// --- The Budget page's four sections must reconcile ---

console.log('\nMoney Flow reconciliation');

// Same key groupings the page uses (src/client/js/budget.js.html).
const BIZ_OBLIGATION_KEYS = ['biz_tax', 'biz_gst', 'legacy_gst', 'biz_acc'];
const PER_OBLIGATION_KEYS = ['per_tax', 'legacy_tax', 'per_acc', 'legacy_acc'];
const DISTRIBUTION_KEYS = ['per_save', 'legacy_save', 'per_donate', 'legacy_donate',
  'per_invest', 'legacy_invest', 'per_spend', 'legacy_spend'];
const WITHHELD_KEYS = ['legacy_tax_withheld', 'legacy_acc_withheld',
  'biz_tax_withheld', 'biz_acc_withheld'];

function catMap(sum) {
  const map = {};
  (sum.scopes || []).forEach(function(g) {
    (g.categories || []).forEach(function(c) { map[c.key] = c; });
  });
  return map;
}

function sumKeys(map, keys) {
  return r2(keys.reduce(function(s, k) { return s + ((map[k] || {}).allocated || 0); }, 0));
}

function revenue(sum, wantLegacy) {
  let total = 0;
  (sum.scopes || []).forEach(function(g) {
    if ((g.scope === 'legacy') !== wantLegacy) return;
    (g.categories || []).forEach(function(c) {
      if (!c.isTransfer) total += c.allocated;
    });
  });
  return r2(total);
}

const flow = app.getBudgetSummary(RANGE);
const map = catMap(flow);

const businessRevenue = revenue(flow, false);
const soleTraderRevenue = revenue(flow, true);
const totalRevenue = r2(businessRevenue + soleTraderRevenue);
const totalObligations = r2(sumKeys(map, BIZ_OBLIGATION_KEYS) + sumKeys(map, PER_OBLIGATION_KEYS));
const reserve = sumKeys(map, ['biz_reserve']);
const personalPot = sumKeys(map, DISTRIBUTION_KEYS);
const withheld = sumKeys(map, WITHHELD_KEYS);

console.log('    revenue ' + totalRevenue + ' (business ' + businessRevenue +
  ', sole trader ' + soleTraderRevenue + ')');
console.log('    obligations ' + totalObligations + ', reserve ' + reserve +
  ', personal pot ' + personalPot + ', withheld ' + withheld);

assert(totalRevenue === r2(flow.totals.allocated),
  'Header 1 boxes sum to the server total, got ' + totalRevenue + ' vs ' + flow.totals.allocated);
// Header 1 - Header 2 = Header 3 (+ any money withheld at source, shown in Header 4).
assert(r2(totalRevenue - totalObligations) === r2(reserve + personalPot + withheld),
  'revenue - obligations = reserve + personal pot + withheld, got ' +
  r2(totalRevenue - totalObligations) + ' vs ' + r2(reserve + personalPot + withheld));
// Header 4's four buckets must cover every distributable personal category the
// server returns. Catches a bucket being added to the registry but not the page.
const flowPersonal = (flow.scopes || []).find(function(g) { return g.scope === 'personal'; });
const distributable = (flowPersonal.categories || [])
  .filter(function(c) { return c.group === 'personal_distribution'; })
  .map(function(c) { return c.key; });
const uncovered = distributable.filter(function(k) { return DISTRIBUTION_KEYS.indexOf(k) === -1; });
assert(uncovered.length === 0,
  'every distributable bucket appears in Header 4' +
  (uncovered.length ? ' — missing ' + uncovered.join(', ') : ''));
assert(personalPot === r2((flowPersonal.categories || [])
  .filter(function(c) { return c.group === 'personal_distribution'; })
  .reduce(function(s, c) { return s + c.allocated; }, 0) +
  sumKeys(map, ['legacy_save', 'legacy_donate', 'legacy_invest', 'legacy_spend'])),
  'personal pot equals the distributable buckets plus their legacy counterparts');

// Owner Pay must be excluded from revenue, not merely reported alongside it.
const naiveRevenue = r2((flow.scopes || []).reduce(function(s, g) {
  return s + (g.categories || []).reduce(function(t, c) { return t + c.allocated; }, 0);
}, 0));
assert(r2(flow.bridge.allocated) > 0, 'fixture actually has an Owner Pay draw');
assert(r2(naiveRevenue - totalRevenue) === r2(flow.bridge.allocated),
  'excluding transfers removes exactly the Owner Pay amount, got ' +
  r2(naiveRevenue - totalRevenue) + ' vs ' + r2(flow.bridge.allocated));

// --- Settling one allocation outright ---

console.log('\nSettling');
const gstRow = written.find(function(w) { return w.category_key === 'biz_gst'; });
app.updateAllocationStatus(gstRow.allocation_id, 'paid', '2026-06-02', 'Paid to IRD');
const after = app.getBudgetSummary(RANGE);
assert(r2(after.accountHoldings.business) === r2(businessExpected - 750),
  'paying GST removes it from business holdings, got ' + after.accountHoldings.business);
assert(r2(after.totals.paid) === 750, 'paid total is 750, got ' + after.totals.paid);

app.updateAllocationStatus(gstRow.allocation_id, 'allocated');
const undone = app.getBudgetSummary(RANGE);
assert(r2(undone.accountHoldings.business) === businessExpected, 'undo restores business holdings');

// --- Paying a bucket ---

console.log('\nPaying a bucket');

function bucket(sum, key) {
  return catMap(sum)[key] || { allocated: 0, paid: 0, outstanding: 0, items: [] };
}

// Business tax is allocated at 1400 on this invoice. Pay part of it.
const part = app.payBudgetCategories('biz_tax', 500, '2026-06-05', 'ASB 4471 | prov tax', RANGE);
const afterPart = app.getBudgetSummary(RANGE);
assert(part.amount === 500, 'the payment records what was asked for, got ' + part.amount);
assert(r2(bucket(afterPart, 'biz_tax').paid) === 500,
  'a part payment moves only what was paid, got ' + bucket(afterPart, 'biz_tax').paid);
assert(r2(bucket(afterPart, 'biz_tax').outstanding) === 900,
  'the rest stays outstanding, got ' + bucket(afterPart, 'biz_tax').outstanding);
assert(bucket(afterPart, 'biz_tax').items[0].status === 'part-paid',
  'a part-paid allocation says so, got ' + bucket(afterPart, 'biz_tax').items[0].status);
assert(bucket(afterPart, 'biz_tax').items[0].transfer_date === '',
  'a part-paid allocation has no settled date yet');
assert(afterPart.payments.length === 1 && afterPart.payments[0].notes === 'ASB 4471 | prov tax',
  'the payment appears in the history with its note intact');
assert(afterPart.payments[0].allocations === 1, 'the payment records what it covered');

// Then the remainder, so the bucket closes out.
app.payBudgetCategories('biz_tax', 900, '2026-06-20', '', RANGE);
const afterFull = app.getBudgetSummary(RANGE);
assert(r2(bucket(afterFull, 'biz_tax').outstanding) === 0,
  'paying the remainder clears the bucket, got ' + bucket(afterFull, 'biz_tax').outstanding);
assert(bucket(afterFull, 'biz_tax').items[0].status === 'paid',
  'the allocation is settled once it is fully covered');
assert(bucket(afterFull, 'biz_tax').items[0].transfer_date === '2026-06-20',
  'the settled date is the payment that closed it, got ' +
  bucket(afterFull, 'biz_tax').items[0].transfer_date);

let refused = '';
try {
  app.payBudgetCategories('biz_tax', 1, '2026-06-21', '', RANGE);
} catch (e) { refused = e.message; }
assert(/Nothing outstanding/.test(refused), 'paying a settled bucket is refused: ' + refused);

refused = '';
try {
  app.payBudgetCategories('biz_acc', 500, '2026-06-21', '', RANGE);
} catch (e) { refused = e.message; }
assert(/more than is outstanding/.test(refused),
  'overpaying is refused rather than silently capped: ' + refused);

refused = '';
try {
  app.payBudgetCategories('biz_acc', 0, '2026-06-21', '', RANGE);
} catch (e) { refused = e.message; }
assert(/greater than zero/.test(refused), 'a zero payment is refused: ' + refused);

refused = '';
try {
  app.payBudgetCategories('not_a_bucket', 10, '2026-06-21', '', RANGE);
} catch (e) { refused = e.message; }
assert(/Unknown budget category/.test(refused), 'an unknown category is refused: ' + refused);

// A merged box: personal tax is per_tax on company invoices and legacy_tax on
// sole-trader ones, and one payment settles across both.
console.log('\nPaying a merged bucket');
const perTaxOutstanding = r2(bucket(afterFull, 'per_tax').outstanding +
  bucket(afterFull, 'legacy_tax').outstanding);
const merged = app.payBudgetCategories(['per_tax', 'legacy_tax'], perTaxOutstanding,
  '2026-06-22', '', RANGE);
const afterMerged = app.getBudgetSummary(RANGE);
assert(merged.amount === perTaxOutstanding,
  'the full remaining amount is accepted, got ' + merged.amount);
assert(r2(bucket(afterMerged, 'per_tax').outstanding) === 0,
  'the company side is cleared');
assert(merged.category === 'Personal Tax + Tax To Pay',
  'the payment is labelled with every bucket it covers, got ' + merged.category);

// --- Undoing a payment ---

console.log('\nUndoing a payment');
const toUndo = afterMerged.payments.find(function(p) { return p.payment_id === part.payment_id; });
assert(!!toUndo, 'the part payment is still in the history');

app.undoBudgetPayment(part.payment_id);
const afterUndo = app.getBudgetSummary(RANGE);
assert(r2(bucket(afterUndo, 'biz_tax').outstanding) === 500,
  'undo puts back exactly what that payment took, got ' + bucket(afterUndo, 'biz_tax').outstanding);
assert(r2(bucket(afterUndo, 'biz_tax').paid) === 900,
  'the other payment against the same bucket is untouched, got ' + bucket(afterUndo, 'biz_tax').paid);
assert(afterUndo.payments.every(function(p) { return p.payment_id !== part.payment_id; }),
  'the undone payment leaves the history');
assert(afterUndo.payments.length === 2, 'the remaining payments survive the row shift, got ' +
  afterUndo.payments.length);

refused = '';
try {
  app.undoBudgetPayment(part.payment_id);
} catch (e) { refused = e.message; }
assert(/Payment not found/.test(refused), 'undoing twice is refused: ' + refused);

// --- A spreadsheet that has not been migrated ---

console.log('\nUn-migrated spreadsheet');
const savedPayments = db.BudgetPayments;
delete db.BudgetPayments;
const realGetAll = app.getAll;
app.getAll = function(name) {
  if (name === 'BudgetPayments') throw new Error('Sheet not found: BudgetPayments');
  return realGetAll(name);
};
const accBefore = r2(bucket(app.getBudgetSummary(RANGE), 'biz_acc').outstanding);
refused = '';
try {
  app.payBudgetCategories('biz_acc', 10, '2026-06-22', '', RANGE);
} catch (e) { refused = e.message; }
assert(/BudgetPayments sheet is missing/.test(refused),
  'a payment is refused before anything is settled: ' + refused);
assert(r2(bucket(app.getBudgetSummary(RANGE), 'biz_acc').outstanding) === accBefore,
  'and the allocations were left exactly as they were');
app.getAll = realGetAll;
db.BudgetPayments = savedPayments;

// --- The date filter bounds a payment ---

console.log('\nDate range');
const narrow = { dateFrom: '2026-05-01', dateTo: '2026-05-31' };
refused = '';
try {
  // The legacy Spend row is on the April invoice, so it is out of this range.
  app.payBudgetCategories('legacy_spend', 10, '2026-06-22', '', narrow);
} catch (e) { refused = e.message; }
assert(/Nothing outstanding/.test(refused),
  'a payment cannot reach an invoice outside the range on screen: ' + refused);

// --- Rows written before partial payments existed ---

console.log('\nBack-compatibility');
assert(app.allocationPaidAmount({ amount: 100, status: 'paid' }) === 100,
  'a blank paid_amount on a paid row means paid in full');
assert(app.allocationPaidAmount({ amount: 100, status: 'allocated' }) === 0,
  'a blank paid_amount on an allocated row means nothing paid');
assert(app.allocationPaidAmount({ amount: 100, status: 'allocated', paid_amount: '' }) === 0,
  'an empty string reads as blank, not as zero-by-Number');
assert(app.allocationPaidAmount({ amount: 100, status: 'allocated', paid_amount: 250 }) === 100,
  'a stray figure can never make a bucket look over-paid');
assert(app.allocationPaidAmount({ amount: 100, status: 'allocated', paid_amount: -5 }) === 0,
  'a negative figure reads as nothing paid');
assert(app.parseCoveredAllocations('BA-002:252;BA-003:18').length === 2,
  'a coverage string round-trips');
assert(app.parseCoveredAllocations('').length === 0, 'an empty coverage string is no allocations');

console.log('\n' + passes + ' passed, ' + failures + ' failed');
process.exit(failures > 0 ? 1 : 0);

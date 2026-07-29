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
  ]
};

// --- Sheet layer stubs (mirroring SheetService.gs) ---

let allocationSeq = 1;

Object.assign(app, {
  LockService: {
    getScriptLock: function() { return { waitLock: function() {}, releaseLock: function() {} }; }
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
    data._rowIndex = db[name].length + 2;
    db[name].push(Object.assign({}, data));
    return data;
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

// --- Settling ---

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

console.log('\n' + passes + ' passed, ' + failures + ' failed');
process.exit(failures > 0 ? 1 : 0);

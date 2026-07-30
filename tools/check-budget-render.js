#!/usr/bin/env node
/**
 * Renders the Budget page's Money Flow sections and checks the resulting HTML.
 *
 *   node tools/check-budget-render.js
 *
 * There is no browser in this repo and no way to run the app locally, so this
 * is the only automated check on the client rendering. It runs the real
 * getBudgetSummary over a fixture containing BOTH a company allocation set and
 * a complete pre-company one, then feeds that into the real render functions
 * from budget.js.html and asserts on the markup.
 *
 * It catches the things that would otherwise only show up in the deployed app:
 * a render function throwing, a section or bucket going missing, buckets
 * rendering out of order, unescaped user text, and undefined/NaN leaking into
 * the page.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

// --- Server: produce a real summary ---

const srv = { Logger: { log: function() {} } };
vm.createContext(srv);
vm.runInContext(['BudgetCategories.gs', 'BudgetService.gs']
  .map(function(f) { return fs.readFileSync(path.join(ROOT, 'src', 'server', f), 'utf8'); })
  .join('\n'), srv, { filename: 'budget-service.js' });

const RULE = {
  rule_id: 'BR-001', name: 'Company Default', model: 'company', is_default: true, active: true,
  biz_tax_withheld_pct: 0, biz_acc_withheld_pct: 0,
  biz_tax_pct: 0.28, biz_acc_pct: 0.01, biz_reserve_pct: 0.10,
  per_tax_pct: 0.30, per_acc_pct: 0.0167,
  per_donate_pct: 0.05, per_save_pct: 0.10, per_invest_pct: 0.15, per_spend_pct: 0.70
};

const db = {
  // Apostrophe on purpose: it must survive escaping into the page.
  Businesses: [{ business_id: 'BIZ-001', name: "Bob's Consulting", currency: 'NZD', active: true, _rowIndex: 2 }],
  Invoices: [
    { invoice_id: '0526', business_id: 'BIZ-001', created_date: '2026-05-31', include_gst: true,
      gst_rate: 0.15, time_subtotal: 5000, subtotal: 5200, gst_amount: 750, total: 5950,
      status: 'paid', budget_rule_id: '', _rowIndex: 2 },
    { invoice_id: '0425', business_id: 'BIZ-001', created_date: '2026-04-30', include_gst: false,
      gst_rate: 0, time_subtotal: 1000, subtotal: 1000, gst_amount: 0, total: 1000,
      status: 'paid', budget_rule_id: 'BR-0', _rowIndex: 3 }
  ],
  BudgetRules: [Object.assign({}, RULE, { _rowIndex: 2 })],
  // A complete sole-trader set on 0425, including tax withheld at source, so
  // the legacy folding and the Legacy section both get exercised. Sums to 1000.
  BudgetAllocations: [
    ['BA-001', 'Tax Withheld', 'legacy_tax_withheld', 100, 'paid'],
    ['BA-002', 'Tax To Pay', 'legacy_tax', 252, 'allocated'],
    ['BA-003', 'ACC To Pay', 'legacy_acc', 18, 'allocated'],
    ['BA-004', 'Spend', 'legacy_spend', 441, 'allocated'],
    ['BA-005', 'Save', 'legacy_save', 63, 'allocated'],
    ['BA-006', 'Donate', 'legacy_donate', 31.5, 'allocated'],
    ['BA-007', 'Invest', 'legacy_invest', 94.5, 'allocated']
  ].map(function(r, i) {
    return {
      allocation_id: r[0], invoice_id: '0425', category: r[1], category_key: r[2],
      scope: 'legacy', percentage: '', amount: r[3], status: r[4],
      transfer_date: r[4] === 'paid' ? '2026-04-30' : '', notes: '', _rowIndex: i + 2
    };
  })
};

let seq = 100;
Object.assign(srv, {
  LockService: { getScriptLock: function() { return { waitLock: function() {}, releaseLock: function() {} }; } },
  withScriptLock: function(fn) { return fn(); },
  getAll: function(n) { return (db[n] || []).map(function(r) { return Object.assign({}, r); }); },
  findById: function(n, id) {
    const rows = db[n] || [];
    const f = Object.keys(rows[0] || {}).filter(function(k) { return k !== '_rowIndex'; })[0];
    return rows.find(function(r) { return srv.idsMatch(r[f], id); }) || null;
  },
  appendRow: function(n, d) {
    if (n === 'BudgetAllocations') d.allocation_id = 'BA-' + (++seq);
    d._rowIndex = db[n].length + 2;
    db[n].push(Object.assign({}, d));
    return d;
  },
  updateRow: function(n, i, d) {
    const k = db[n].findIndex(function(r) { return r._rowIndex === i; });
    if (k >= 0) db[n][k] = Object.assign({}, d);
    return d;
  },
  idsMatch: function(a, b) {
    const x = String(a), y = String(b);
    return x === y || (x.replace(/^0+/, '') === y.replace(/^0+/, '') && x !== '' && y !== '');
  },
  normalizeId: function(i) { return String(i).replace(/^0+/, '') || '0'; },
  isTruthy: function(v) { return v === true || v === 'TRUE' || v === 'true'; },
  todayLocal: function() { return '2026-06-01'; },
  dateOnly: function(v) { return (String(v).match(/^(\d{4}-\d{2}-\d{2})/) || ['', ''])[1]; },
  getByDateRange: function(n, c, f, t) {
    return srv.getAll(n).filter(function(r) {
      const d = srv.dateOnly(r[c]);
      return d && (!f || d >= f) && (!t || d <= t);
    });
  },
  getByYear: function(n, c, y) {
    return srv.getAll(n).filter(function(r) { return srv.dateOnly(r[c]).indexOf(String(y)) === 0; });
  },
  getByDateParams: function(n, c, p) {
    if (typeof p === 'object' && p !== null) {
      if (!p.dateFrom && !p.dateTo) return srv.getAll(n);
      return srv.getByDateRange(n, c, p.dateFrom, p.dateTo);
    }
    return p ? srv.getByYear(n, c, p) : srv.getAll(n);
  },
  isFilteringParams: function(p) {
    if (typeof p === 'object' && p !== null) return !!(p.dateFrom || p.dateTo);
    return !!p;
  }
});

srv.allocateBudget('0526', 'BR-001');
const summary = srv.getBudgetSummary({ dateFrom: '2026-01-01', dateTo: '2026-12-31' });

// --- Client: load the real render functions ---

function inlineScript(file) {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'client', 'js', file), 'utf8');
  return /<script[^>]*>([\s\S]*?)<\/script>/.exec(src)[1];
}

const cli = { console: console, document: { getElementById: function() { return null; } }, prompt: function() { return null; } };
cli.serverCall = function() { return Promise.resolve(null); };
vm.createContext(cli);
// utils.js.html declares `var AppCache`, so populate it AFTER loading.
vm.runInContext(inlineScript('utils.js.html') + '\n' + inlineScript('budget.js.html'),
  cli, { filename: 'budget-client.js' });
cli.AppCache.budgetCategories = srv.getBudgetCategories();
cli.AppCache.businesses = db.Businesses;

const cats = cli.catByKey(summary);
const html =
  cli.renderRevenueSection(summary, cats) +
  cli.renderObligationsSection(cats) +
  cli.renderIncomeSection(cats) +
  cli.renderAllocationsSection(cats);

// --- Harness ---

let failures = 0;
let passes = 0;

function check(label, cond) {
  if (cond) {
    passes++;
    console.log('  ok    ' + label);
  } else {
    failures++;
    console.log('  FAIL  ' + label);
  }
}

function money(s) { return Number(String(s).replace(/[^0-9.-]/g, '')); }
function sectionTotal(label) {
  const m = new RegExp(label + ' <span class="section-total">([^<]+)').exec(html);
  return m ? money(m[1]) : NaN;
}

console.log('\nHeader 1 — Total revenue');
check('header present', html.indexOf('>Total revenue ') !== -1);
check('Business revenue box', html.indexOf('Business revenue') !== -1);
check('Sole trader revenue box', html.indexOf('Sole trader revenue') !== -1);
const tiles = Array.from(html.matchAll(/flow-tile__value">([^<]+)/g)).map(function(m) { return money(m[1]); });
check('boxes sum to the header total',
  Math.abs((tiles[0] + tiles[1]) - sectionTotal('Total revenue')) < 0.02);
check('business revenue is billed hours + GST (5750), got ' + tiles[0], tiles[0] === 5750);
check('sole trader revenue is 1000, got ' + tiles[1], tiles[1] === 1000);

console.log('\nHeader 2 — Total obligations');
check('header present', html.indexOf('>Total obligations ') !== -1);
check('two columns, Business and Personal',
  (html.match(/<h4>Business<\/h4>/g) || []).length === 1 &&
  (html.match(/<h4>Personal<\/h4>/g) || []).length === 1);
check('Tax to pay appears on both sides', (html.match(/Tax to pay/g) || []).length === 2);
check('GST to pay appears once', (html.match(/GST to pay/g) || []).length === 1);
check('ACC to pay appears on both sides', (html.match(/ACC to pay/g) || []).length === 2);
check('the sole-trader portion of personal tax is named', html.indexOf('sole trader') !== -1);
check('boxes show Paid X of Y', html.indexOf('mini-tile__split') !== -1);

console.log('\nHeader 3 — Total income');
check('header present', html.indexOf('>Total income ') !== -1);
check('Reserve pot box', html.indexOf('Business: Reserve pot') !== -1);
check('Personal pot box', html.indexOf('Personal: Personal pot') !== -1);
check('Reserve is 500, got ' + tiles[2], tiles[2] === 500);
// Company distribution 2084.07 + legacy 630.
check('Personal pot is 2714.07, got ' + tiles[3], tiles[3] === 2714.07);
check('sub-figures name both sources',
  html.indexOf('from business') !== -1 && html.indexOf('sole trader') !== -1);

console.log('\nHeader 4 — Allocations');
check('header present', html.indexOf('>Allocations ') !== -1);
check('owner pay draw subheading', html.indexOf('Business: owner pay draw') !== -1);
check('legacy withheld subheading', html.indexOf('Legacy: tax withheld') !== -1);
['Save', 'Donate', 'Invest', 'Spend'].forEach(function(label) {
  check('block for ' + label, html.indexOf('<h4>' + label + '</h4>') !== -1);
});
const order = ['Save', 'Donate', 'Invest', 'Spend'].map(function(l) { return html.indexOf('<h4>' + l + '</h4>'); });
check('buckets in the requested order', order.every(function(v, i) { return i === 0 || v > order[i - 1]; }));
check('Mark Set Aside on Save (a held bucket)', /Save<\/h4>[\s\S]*?Mark Set Aside/.test(html));
check('Mark Transferred on the owner pay draw', /Owner Pay draw<\/h4>[\s\S]*?Mark Transferred/.test(html));
check('Mark Paid on Donate (a paid-out bucket)', /Donate<\/h4>[\s\S]*?Mark Paid/.test(html));
check('withheld rows offer no action',
  (html.split('Legacy: tax withheld')[1] || '').indexOf('<button') === -1);
check('company and sole-trader money share one Spend block',
  /Spend<\/h4>[\s\S]*?<code>0425<\/code>/.test(html) && /Spend<\/h4>[\s\S]*?<code>0526<\/code>/.test(html));
check('per-invoice rows listed', html.indexOf('<code>0526</code>') !== -1 && html.indexOf('<code>0425</code>') !== -1);
check('progress bars restored', (html.match(/progress-bar__fill/g) || []).length >= 5);

console.log('\nWhole page');
check('three two-column rows', (html.match(/class="pot-grid"/g) || []).length === 3);
check('user text is HTML-escaped', html.indexOf('Bob&#39;s Consulting') !== -1);
check('no undefined or NaN leaked into the markup', !/undefined|NaN/.test(html));
// Header 1 - Header 2 = Header 3 + withheld, as displayed.
const withheldShown = 100;
check('the displayed sections reconcile',
  Math.abs((sectionTotal('Total revenue') - sectionTotal('Total obligations')) -
    (sectionTotal('Total income') + withheldShown)) < 0.02);

console.log('\n' + passes + ' passed, ' + failures + ' failed');
process.exit(failures > 0 ? 1 : 0);

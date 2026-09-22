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

db.BudgetPayments = [];

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
    if (n === 'BudgetPayments') d.payment_id = 'BP-' + (++seq);
    d._rowIndex = db[n].length + 2;
    db[n].push(Object.assign({}, d));
    return d;
  },
  deleteRow: function(n, i) {
    db[n] = db[n].filter(function(r) { return r._rowIndex !== i; });
    db[n].forEach(function(r, k) { r._rowIndex = k + 2; });
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

// A part payment, so the page is checked with money genuinely half-settled:
// $1,000 against GST, which is allocated at $750 (company) — capped at what is
// outstanding — and $200 against personal tax, which is allocated at far more.
srv.payBudgetCategories('biz_gst,legacy_gst', 750, '2026-06-02', 'ASB 4471 | GST Q2',
  { dateFrom: '2026-01-01', dateTo: '2026-12-31' });
srv.payBudgetCategories('per_tax,legacy_tax', 200, '2026-06-03', '',
  { dateFrom: '2026-01-01', dateTo: '2026-12-31' });

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
vm.runInContext([
  inlineScript('utils.js.html'),
  inlineScript('budget.js.html'),
  inlineScript('dashboard.js.html'),
  inlineScript('invoices.js.html')
].join('\n'), cli, { filename: 'budget-client.js' });
cli.AppCache.budgetCategories = srv.getBudgetCategories();
cli.AppCache.businesses = db.Businesses;

const cats = cli.catByKey(summary);

// The overview and the history are asserted separately: bucket labels appear
// in both, so a count taken over the whole page would say nothing about where
// they landed.
const map = cli.renderMoneyMap(summary, cats);
const html =
  cli.renderRevenueSection(summary, cats) +
  cli.renderObligationsSection(cats) +
  cli.renderIncomeSection(cats) +
  cli.renderAllocationsSection(cats);
const history = cli.renderHistorySection(summary, cats);
const page = map + html + history;

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

console.log('\nHeader 1 — Revenue');
check('header present', html.indexOf('>Revenue') !== -1);
check('Business revenue box', html.indexOf('Business revenue') !== -1);
check('Personal revenue box', html.indexOf('Personal revenue') !== -1);
const tiles = Array.from(html.matchAll(/flow-tile__value">([^<]+)/g)).map(function(m) { return money(m[1]); });
check('business revenue is everything invoiced (5750), got ' + tiles[0], tiles[0] === 5750);
// Personal revenue = owner pay draw 3050 + sole trader 1000, pre-allocations.
check('personal revenue is draw + sole trader (4050), got ' + tiles[1], tiles[1] === 4050);
check('the two views are not summed into a header total',
  !/Revenue <span class="section-total">/.test(html));
check('the overlap is spelled out', /overlap and are not added together/.test(html));
check('the allocated-only caveat is stated', /allocated<\/strong> invoices only/.test(html));
check('the overlap note names the draw amount', html.indexOf('$3,050.00 owner pay draw') !== -1);
check('sub-figures name owner pay and sole trader separately',
  html.indexOf('owner pay $3,050.00') !== -1 && html.indexOf('sole trader $1,000.00') !== -1);

console.log('\nHeader 2 — Total obligations');
check('header present', html.indexOf('>Total obligations ') !== -1);
check('two columns, Business and Personal',
  (html.match(/<h4>Business<\/h4>/g) || []).length === 1 &&
  (html.match(/<h4>Personal<\/h4>/g) || []).length === 1);
function boxCount(label) {
  return (html.match(new RegExp('mini-tile__label">' + label + '<', 'g')) || []).length;
}
check('Tax to pay appears on both sides', boxCount('Tax to pay') === 2);
check('GST to pay appears once', boxCount('GST to pay') === 1);
check('ACC to pay appears on both sides', boxCount('ACC to pay') === 2);
check('the header counts what is still owed, not what was allocated',
  Math.abs(sectionTotal('Total obligations') - 2485.93) < 0.02);
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
  check('box for ' + label, html.indexOf('mini-tile__label">' + label + '<') !== -1);
});
const order = ['Save', 'Donate', 'Invest', 'Spend']
  .map(function(l) { return html.indexOf('mini-tile__label">' + l + '<'); });
check('buckets in the requested order', order.every(function(v, i) { return i === 0 || v > order[i - 1]; }));
check('no per-invoice rows in the overview — that is what the history is for',
  html.indexOf('<code>0526</code>') === -1 && html.indexOf('<code>0425</code>') === -1);
check('withheld money offers no action',
  (html.split('Legacy: tax withheld')[1] || '').indexOf('<button') === -1);

console.log('\nOverview actions');
function verbFor(label) {
  const m = new RegExp('mini-tile__label">' + label +
    '<[\\s\\S]*?tile-action">(.*?)</div>').exec(html);
  return m ? m[1] : '';
}
// Every button says Pay, whatever the bucket's settle mode — one act, one word.
check('Pay on Save (a held bucket)', verbFor('Save').indexOf('>Pay<') !== -1);
// The draw and the Reserve pot are action bars, not boxes: their figures are
// already in the subheading and the pot tile above them.
function potActionFor(label) {
  const m = new RegExp('pot-action__label">' + label +
    ' &mdash;[\\s\\S]*?</span>(.*?)</div>').exec(html);
  return m ? m[1] : '';
}
check('Pay on the owner pay draw', potActionFor('Owner pay draw').indexOf('>Pay<') !== -1);
check('Pay on the Reserve pot', potActionFor('Reserve pot').indexOf('>Pay<') !== -1);
check('no bucket offers a different verb',
  html.indexOf('>Set aside<') === -1 && html.indexOf('>Transfer<') === -1);
check('one phrase for money still owed, everywhere on the page',
  html.indexOf('still to set aside') === -1 &&
  html.indexOf('still to draw') === -1 &&
  html.indexOf('still to action') === -1 &&
  (html.match(/still to pay/g) || []).length >= 6);
check('the Reserve figure is not repeated in a second box',
  html.indexOf('mini-tile__label">Reserve') === -1);
check('Pay on Donate (a paid-out bucket)', verbFor('Donate').indexOf('>Pay<') !== -1);
check('Pay on GST', verbFor('GST to pay').indexOf('>') !== -1);
check('a fully settled bucket offers no button, it says so',
  verbFor('GST to pay').indexOf('paid in full') !== -1 &&
  verbFor('GST to pay').indexOf('<button') === -1);
check('every action opens the payment panel, not a per-invoice toggle',
  (html.match(/onclick="openPayPanel\(/g) || []).length >= 8 &&
  html.indexOf('markAllocationPaid') === -1);
check('merged buckets pass every key they cover',
  html.indexOf("'per_tax,legacy_tax'") !== -1);
check('one payment host per actionable section',
  (html.match(/class="pay-host"/g) || []).length === 3);

console.log('\nMoney map');
check('both accounts named', map.indexOf('Business account') !== -1 && map.indexOf('Personal account') !== -1);
check('owner pay is the bridge between them', /money-map__bridge-label">Owner pay/.test(map));
check('the bridge carries the draw amount', map.indexOf('$3,050.00') !== -1);
check('business side shows invoiced, obligations and reserve',
  ['Invoiced in', 'Obligations out', 'Reserve kept'].every(function(l) { return map.indexOf(l) !== -1; }));
check('personal side shows what came in and what is left to allocate',
  map.indexOf('>To allocate<') !== -1 && map.indexOf('owner pay + $1,000.00 sole trader') !== -1);
check('the map agrees with the Revenue box (5750)', map.indexOf('$5,750.00') !== -1);
check('no undefined or NaN in the money map', !/undefined|NaN/.test(map));

console.log('\nHistory');
check('collapsed by default', /<details class="flow-group history-group">/.test(history) &&
  history.indexOf('<details class="flow-group history-group" open') === -1);
check('payments table lists both payments',
  (history.match(/onclick="undoPayment\(/g) || []).length === 2);
check('a payment note containing a pipe survives', history.indexOf('ASB 4471 | GST Q2') !== -1);
check('per-invoice rows live here', history.indexOf('<code>0526</code>') !== -1 &&
  history.indexOf('<code>0425</code>') !== -1);
check('company and sole-trader money share one Spend block',
  /Spend<\/h4>[\s\S]*?<code>0425<\/code>/.test(history) && /Spend<\/h4>[\s\S]*?<code>0526<\/code>/.test(history));
check('progress bars per bucket', (history.match(/progress-bar__fill/g) || []).length >= 5);
check('a part-paid allocation is labelled as such', history.indexOf('badge-part-paid') !== -1);
check('the settled column is shown per allocation', history.indexOf('>Settled</th>') !== -1);
check('history is read-only apart from undo',
  history.indexOf('markAllocationPaid') === -1 && history.indexOf('markAllocationUnpaid') === -1);

console.log('\nWhole page');
check('three two-column rows', (html.match(/class="pot-grid"/g) || []).length === 3);
check('user text is HTML-escaped', page.indexOf('Bob&#39;s Consulting') !== -1);
check('no undefined or NaN leaked into the markup', !/undefined|NaN/.test(page));
// Invoiced revenue - obligations = income + withheld, as displayed. Invoiced
// revenue is the business box plus sole trader; the personal box is the
// overlapping view and deliberately plays no part in this identity.
const invoicedRevenue = tiles[0] + 1000;
const withheldShown = 100;
// Against ALLOCATED obligations: the header shows what is still owed, which
// falls as payments are recorded, but the identity is about where the money
// was assigned, not how much of it has left the account yet.
const obligationsAllocated = cli.sumCats(cats,
  cli.BIZ_OBLIGATIONS.concat(cli.PERSONAL_OBLIGATIONS)
    .reduce(function(keys, row) { return keys.concat(row.keys); }, [])).allocated;
check('the displayed sections reconcile',
  Math.abs((invoicedRevenue - obligationsAllocated) -
    (sectionTotal('Total income') + withheldShown)) < 0.02);
check('payments reduce what is owed without moving what was allocated',
  Math.abs(obligationsAllocated - sectionTotal('Total obligations') - 950) < 0.02);

// --- Dashboard budget tile, over the same allocations ---

console.log('\nDashboard budget tile');

// Mirrors the shape DashboardService.getDashboardData returns for `budget`.
const dashData = srv.allCategoryDefs().map(function(def) {
  const cat = cats[def.key];
  return {
    category: def.label, key: def.key, scope: def.scope, group: def.group,
    settle: def.settle, isTransfer: !!def.isTransfer,
    allocated: cat ? cat.allocated : 0,
    paid: cat ? cat.paid : 0,
    outstanding: cat ? cat.outstanding : 0
  };
}).filter(function(c) { return c.allocated > 0; });

const dash = cli.dashBudget(dashData);

check('three groups render', ['Total revenue', 'Total obligations', 'Personal allocations']
  .every(function(t) { return dash.indexOf(t) !== -1; }));
check('revenue shows business and personal', /Total revenue[\s\S]*?Business[\s\S]*?Personal/.test(dash));
check('revenue says the views are not added together',
  dash.indexOf('not added together') !== -1);
const dashAmounts = Array.from(dash.matchAll(/dash-budget-item__amount">([^<]+)/g))
  .map(function(m) { return money(m[1]); });
check('business revenue matches the Budget page (5750), got ' + dashAmounts[0], dashAmounts[0] === 5750);
check('personal revenue matches the Budget page (4050), got ' + dashAmounts[1], dashAmounts[1] === 4050);
check('obligations split business/personal, outstanding only — ' +
  dashAmounts[2] + ' / ' + dashAmounts[3],
  dashAmounts[2] === 1450 && dashAmounts[3] === 1035.93);
check('four personal allocation boxes in spend/save/invest/donate order',
  /Spend[\s\S]*?Save[\s\S]*?Invest[\s\S]*?Donate/.test(dash.split('Personal allocations')[1]));
check('allocation amounts match the Budget page buckets',
  dashAmounts.slice(4).join(',') === '1899.85,271.41,407.11,135.7');
check('no undefined or NaN in the dashboard tile', !/undefined|NaN/.test(dash));
check('dashboard reuses the Budget page groupings, not its own copies',
  typeof cli.BIZ_OBLIGATIONS !== 'undefined' && typeof cli.PERSONAL_ALLOCATIONS !== 'undefined');

// --- Dashboard Hours & Earnings table ---

console.log('\nDashboard hours table');

const bizMap = { 'BIZ-001': { name: "Bob's Consulting", currency: 'NZD' },
  'BIZ-002': { name: 'Beta Corp', currency: 'NZD' } };
const dashTimeEntries = [
  { business_id: 'BIZ-001', hours: 8, line_total: 1200 },
  { business_id: 'BIZ-001', hours: 2, line_total: 300 }
];
const dashInvoices = [
  // time_subtotal is billed time only; total and subtotal carry GST/expenses.
  { business_id: 'BIZ-001', status: 'paid', time_subtotal: 5000, subtotal: 5200, total: 5950 },
  { business_id: 'BIZ-001', status: 'void', time_subtotal: 9999, subtotal: 9999, total: 9999 },
  // Invoiced this period, no hours logged in it — May's work billed in June.
  { business_id: 'BIZ-002', status: 'sent', time_subtotal: 800, subtotal: 800, total: 920 }
];
const hoursHtml = cli.dashHours(dashTimeEntries, dashInvoices, bizMap);

check('an Invoiced column is present', hoursHtml.indexOf('>Invoiced<') !== -1);
check('invoiced uses billed time, not the GST-inclusive total',
  hoursHtml.indexOf('$5,000.00') !== -1 && hoursHtml.indexOf('$5,950.00') === -1);
check('voided invoices are excluded', hoursHtml.indexOf('9,999') === -1);
check('a business invoiced but with no hours still gets a row',
  hoursHtml.indexOf('Beta Corp') !== -1 && hoursHtml.indexOf('$800.00') !== -1);
check('that row shows zero hours rather than blank', /Beta Corp<\/td>[\s\S]*?>0\.0</.test(hoursHtml));
check('hours and earned are unchanged',
  hoursHtml.indexOf('10.0') !== -1 && hoursHtml.indexOf('$1,500.00') !== -1);
check('the total row totals invoiced too', /total-row[\s\S]*?\$5,800\.00/.test(hoursHtml));
check('the caveat about expenses and GST is stated',
  hoursHtml.indexOf('excludes expenses and GST') !== -1);
check('no undefined or NaN in the hours table', !/undefined|NaN/.test(hoursHtml));

// --- Printed invoice ---

console.log('\nPrinted invoice');

// renderInvoiceDetail writes into #invoice-tab-content, so capture that write.
let printed = '';
cli.document.getElementById = function() {
  return { set innerHTML(v) { printed = v; }, get innerHTML() { return printed; } };
};

cli.renderInvoiceDetail({
  invoice: { invoice_id: 'BC0526', created_date: '2026-05-31', date_from: '2026-05-01',
    date_to: '2026-05-31', po_number: 'PO-4471', status: 'sent', include_gst: true,
    gst_rate: 0.15, time_subtotal: 5000, subtotal: 5000, gst_amount: 750, total: 5750,
    description: '', notes: '' },
  business: { name: 'Auckland Transport', currency: 'NZD' },
  myDetails: { business_name: 'Me Ltd', gst_number: '123-456-789', tax_number: '987-654-321',
    bank_account: '12-3456-0000000-00', payment_terms: 'Due within 14 days' },
  timeEntries: [], expenses: [], allocations: [],
  subtotals: { time: 5000, expenses: 0 }
});

check('the PO number is printed', printed.indexOf('PO-4471') !== -1);
check('it is labelled', printed.indexOf('PO #:') !== -1);
check('the GST number is printed', printed.indexOf('123-456-789') !== -1);
check('the IRD number is NOT printed', printed.indexOf('987-654-321') === -1);
check('no leftover Tax # label', printed.indexOf('Tax #:') === -1);

// An invoice with no PO must simply omit the line, not render an empty one.
printed = '';
cli.renderInvoiceDetail({
  invoice: { invoice_id: 'BC0626', created_date: '2026-06-30', date_from: '2026-06-01',
    date_to: '2026-06-30', po_number: '', status: 'draft', include_gst: false,
    gst_rate: 0, time_subtotal: 100, subtotal: 100, gst_amount: 0, total: 100,
    description: '', notes: '' },
  business: { name: 'Auckland Transport', currency: 'NZD' },
  myDetails: { business_name: 'Me Ltd', gst_number: '123-456-789' },
  timeEntries: [], expenses: [], allocations: [],
  subtotals: { time: 100, expenses: 0 }
});
check('no PO line when there is no PO', printed.indexOf('PO #:') === -1);
check('the invoice still renders without one', printed.indexOf('BC0626') !== -1);

console.log('\n' + passes + ' passed, ' + failures + ' failed');
process.exit(failures > 0 ? 1 : 0);

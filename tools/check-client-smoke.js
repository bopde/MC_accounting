#!/usr/bin/env node
/**
 * Smoke test for every client page render path.
 *
 *   node tools/check-client-smoke.js
 *
 * The app only runs inside Apps Script, so nothing here has ever exercised
 * hours.js, invoices.js, accounts.js or settings.js. A typo, a renamed helper or
 * a null dereference in any of them is invisible until the page is opened in the
 * deployed app.
 *
 * This loads all the client modules into one context with a minimal DOM, stubs
 * serverCall with plausible fixtures, and drives every page and tab. It asserts
 * that nothing throws, that no error toast is raised, and that each page put
 * something in its container. It does NOT check layout or wording — that is what
 * check-budget-render.js does for the Budget page.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

// --- Minimal DOM ---

function makeElement(tag, id) {
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    id: id || '',
    innerHTML: '',
    textContent: '',
    value: '',
    checked: false,
    hidden: false,
    style: {},
    dataset: {},
    children: [],
    className: '',
    classList: {
      add: function() {}, remove: function() {}, toggle: function() {},
      contains: function() { return false; }
    },
    addEventListener: function() {},
    removeEventListener: function() {},
    dispatchEvent: function() {},
    appendChild: function(child) { el.children.push(child); return child; },
    removeChild: function() {},
    remove: function() {},
    scrollIntoView: function() {},
    closest: function() { return el; },
    querySelector: function() { return makeElement('div'); },
    querySelectorAll: queryAll,
    getContext: function() { return null; },
    setAttribute: function() {},
    getAttribute: function() { return null; },
    removeAttribute: function() {},
    hasAttribute: function() { return false; },
    focus: function() {},
    reset: function() {},
    submit: function() {},
    // hours.js clones-and-replaces selects to drop stale change listeners.
    cloneNode: function() { return makeElement(tag, id); }
  };
  el.parentNode = {
    replaceChild: function() {},
    removeChild: function() {},
    appendChild: function() {},
    insertBefore: function() {}
  };
  return el;
}

// Every getElementById returns a live element, so render code that reaches for a
// field it just wrote into innerHTML still finds one.
const elements = {};
// A selector ending in `button` yields a row of buttons, so the tab-switching
// code runs for real instead of short-circuiting on an empty list.
function queryAll(selector) {
  if (/button$/.test(String(selector))) {
    const buttons = [];
    for (let i = 0; i < 6; i++) buttons.push(makeElement('button'));
    return buttons;
  }
  return [];
}

const doc = {
  getElementById: function(id) {
    if (!elements[id]) elements[id] = makeElement('div', id);
    return elements[id];
  },
  createElement: makeElement,
  querySelector: function() { return makeElement('div'); },
  querySelectorAll: queryAll,
  body: makeElement('body'),
  addEventListener: function() {}
};

// --- Fixtures for every server call the client makes ---

const BUSINESS = {
  business_id: 'BIZ-001', name: "Bob's Consulting", contact_name: 'Bob',
  email: 'bob@example.com', address: '1 Test St', default_rate: 150,
  currency: 'NZD', invoice_code: '', invoice_prefix: 'BC',
  invoice_prefix_auto: 'BC', active: true, _rowIndex: 2
};

const WORK_CODE = { code_id: 'DEV', description: 'Development', category: 'billable',
  contract_id: '', active: true, _rowIndex: 2 };

const ACCOUNT = { account_id: 'ACC-001', name: 'ASB Business', type: 'bank',
  currency: 'NZD', scope: 'business', purpose: 'operating', active: true, _rowIndex: 2 };

const RULE = {
  rule_id: 'BR-001', name: 'Company Default', model: 'company', is_default: true, active: true,
  biz_tax_withheld_pct: 0, biz_acc_withheld_pct: 0, biz_tax_pct: 0.28, biz_acc_pct: 0.01,
  biz_reserve_pct: 0.10, per_tax_pct: 0.30, per_acc_pct: 0.0167,
  per_donate_pct: 0.05, per_save_pct: 0.10, per_invest_pct: 0.15, per_spend_pct: 0.70,
  notes: '', _rowIndex: 2
};

// A legacy rule too, so the sole-trader form path renders.
const LEGACY_RULE = {
  rule_id: 'BR-000', name: 'Old Split', model: '', is_default: false, active: true,
  tax_withheld_pct: 0.1, tax_to_pay_pct: 0.28, acc_withheld_pct: 0, acc_to_pay_pct: 0.02,
  donate_pct: 0.05, save_pct: 0.10, invest_pct: 0.15, spend_pct: 0.70, notes: '', _rowIndex: 3
};

const CONTRACT = { contract_id: 'CON-001', business_id: 'BIZ-001', name: 'Phase 1',
  po_number: 'PO-1', date_from: '2026-01-01', date_to: '2026-12-31', value: 50000,
  currency: 'NZD', work_codes: 'DEV', status: 'active', notes: '', _rowIndex: 2 };

const INVOICE = { invoice_id: 'BC0526', business_id: 'BIZ-001', business_name: "Bob's Consulting",
  currency: 'NZD', date_from: '2026-05-01', date_to: '2026-05-31', created_date: '2026-05-31',
  include_gst: true, gst_rate: 0.15, time_subtotal: 5000, subtotal: 5000, gst_amount: 750,
  total: 5750, status: 'paid', budget_rule_id: '', contract_id: '', po_number: '',
  description: '', notes: '', line_descriptions: '', _rowIndex: 2 };

const TIME_ENTRY = { entry_id: 'TE-001', business_id: 'BIZ-001', date: '2026-05-15',
  time_start: '09:00', time_end: '17:00', hours: 8, description: 'Work',
  work_code: 'DEV', rate: 150, line_total: 1200, invoice_id: '', contract_id: '', _rowIndex: 2 };

const EXPENSE = { expense_id: 'EXP-001', business_id: 'BIZ-001', date: '2026-05-10',
  amount: 200, description: 'Travel', work_code: 'DEV', invoice_id: '', _rowIndex: 2 };

const ALLOCATION = { allocation_id: 'BA-001', invoice_id: 'BC0526', category: 'Spend',
  category_key: 'per_spend', scope: 'personal', percentage: 0.7, amount: 1458.85,
  status: 'allocated', transfer_date: '', notes: '', _rowIndex: 2 };

const BUDGET_CATEGORIES = (function() {
  const srv = { Logger: { log: function() {} } };
  vm.createContext(srv);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/server/BudgetCategories.gs'), 'utf8'),
    srv, { filename: 'registry.js' });
  return srv.getBudgetCategories();
})();

function budgetSummaryFixture() {
  const cats = BUDGET_CATEGORIES.categories;
  function cat(key, amount) {
    const def = cats.find(function(d) { return d.key === key; });
    return {
      key: key, category: def.label, scope: def.scope, group: def.group,
      settle: def.settle, isTransfer: !!def.isTransfer, isWithheld: def.settle === 'auto_paid',
      allocated: amount, paid: 0, outstanding: amount,
      items: [{ allocation_id: 'BA-' + key, invoice_id: 'BC0526',
        business_name: "Bob's Consulting", amount: amount, paid: 0,
        outstanding: amount, status: 'allocated', transfer_date: '', notes: '' }]
    };
  }
  return {
    scopes: [
      { scope: 'business', label: 'Business', accountHint: 'business account',
        categories: [cat('biz_gst', 750), cat('biz_tax', 1400), cat('biz_acc', 50), cat('biz_reserve', 500)],
        allocated: 2700, paid: 0, outstanding: 2700 },
      { scope: 'bridge', label: 'Owner Pay', accountHint: '',
        categories: [cat('owner_pay', 3050)], allocated: 3050, paid: 0, outstanding: 3050 },
      { scope: 'personal', label: 'Personal', accountHint: 'personal account',
        categories: [cat('per_tax', 915), cat('per_acc', 50.93), cat('per_donate', 104.2),
          cat('per_save', 208.41), cat('per_invest', 312.61), cat('per_spend', 1458.85)],
        allocated: 3050, paid: 0, outstanding: 3050 }
    ],
    categories: [], bridge: { allocated: 3050, paid: 0, outstanding: 3050 },
    accountHoldings: { business: 2700, personal: 3050, legacy: 0 },
    totals: { allocated: 5750, paid: 0, outstanding: 5750, allocationCount: 10 },
    payments: [{ payment_id: 'BP-001', payment_date: '2026-06-02', category: 'GST',
      category_key: 'biz_gst', scope: 'business', amount: 750,
      notes: 'ASB 4471 | GST Q2', allocations: 1 }]
  };
}

const RESPONSES = {
  bootstrap: {
    businesses: [BUSINESS], workCodes: [WORK_CODE], accounts: [ACCOUNT],
    budgetRules: [RULE, LEGACY_RULE], budgetCategories: BUDGET_CATEGORIES,
    contracts: [CONTRACT], myDetails: { business_name: 'Me', bank_account: '12-3456' },
    schemaWarnings: [], errors: []
  },
  getDashboardData: {
    invoices: [INVOICE], timeEntries: [TIME_ENTRY], expenses: [EXPENSE],
    budget: BUDGET_CATEGORIES.categories.map(function(def) {
      const amounts = { biz_gst: 750, biz_tax: 1400, biz_acc: 50, biz_reserve: 500,
        owner_pay: 3050, per_tax: 915, per_acc: 50.93, per_donate: 104.2,
        per_save: 208.41, per_invest: 312.61, per_spend: 1458.85 };
      return {
        category: def.label, key: def.key, scope: def.scope, group: def.group,
        settle: def.settle, isTransfer: !!def.isTransfer,
        allocated: amounts[def.key] || 0, paid: 0, outstanding: amounts[def.key] || 0
      };
    }).filter(function(c) { return c.allocated > 0; }),
    accountBalances: [{ name: 'ASB Business', currency: 'NZD', balance: 12500, month: '2026-05' }],
    contractProgress: [{ contract_id: 'CON-001', business_id: 'BIZ-001',
      business_name: "Bob's Consulting", name: 'Phase 1', po_number: 'PO-1',
      date_from: '2026-01-01', date_to: '2026-12-31', value: 50000, currency: 'NZD',
      spent: 12000, hours: 80, days_remaining: 150, total_days: 365,
      expected_pct: 0.5, actual_pct: 0.24 }]
  },
  getTimeEntries: [TIME_ENTRY],
  getExpenses: [EXPENSE],
  getInvoicesWithDetails: [INVOICE],
  getInvoiceDetails: {
    invoice: INVOICE, business: BUSINESS, myDetails: RESPONSES_MY_DETAILS(),
    timeEntries: [TIME_ENTRY], expenses: [EXPENSE], allocations: [ALLOCATION],
    subtotals: { time: 5000, expenses: 200 }
  },
  getUninvoicedItems: { timeEntries: [TIME_ENTRY], expenses: [EXPENSE] },
  getBudgetSummary: budgetSummaryFixture(),
  payBudgetCategoriesFromClient: { payment_id: 'BP-002', amount: 400,
    category: 'Business Tax', allocations: 1 },
  undoBudgetPaymentFromClient: { success: true, amount: 750, category: 'GST' },
  deallocateInvoiceFromClient: { success: true, removed: 11, invoice_id: 'BC0526' },
  getBudgetRules: [RULE, LEGACY_RULE],
  getAllBusinesses: [BUSINESS],
  getAccountSummariesForMonth: { current: [], previous: [] },
  getYearOverview: { accounts: [ACCOUNT], months: [], rows: [] },
  previewAllocationFromClient: {
    invoice_id: 'BC0526', business_name: "Bob's Consulting", currency: 'NZD',
    rule: { rule_id: 'BR-001', name: 'Company Default', model: 'company' },
    model: 'company', total: 5750,
    stages: { gross: 5000, withheld: 0, businessIncome: 5000, gst: 750,
      businessObligations: 1950, ownerPay: 3050, personalObligations: 965.93, personalNet: 2084.07 },
    lines: BUDGET_CATEGORIES.categories.map(function(def) {
      return { key: def.key, label: def.label, scope: def.scope, group: def.group,
        basis: def.basis, settle: def.settle, isTransfer: !!def.isTransfer,
        pct: def.pctField ? 0.1 : null, amount: 100 };
    })
  },
  getAllClient: function(arg) {
    if (arg === 'BudgetAllocations') return [ALLOCATION];
    if (arg === 'Contracts') return [CONTRACT];
    if (arg === 'Accounts') return [ACCOUNT];
    if (arg === 'WorkCodes') return [WORK_CODE];
    if (arg === 'BudgetRules') return [RULE, LEGACY_RULE];
    return [];
  }
};

function RESPONSES_MY_DETAILS() {
  return { business_name: 'Me', contact_name: 'Bob', email: 'me@example.com',
    phone: '021', address: '1 Test St', tax_number: '123', gst_number: '456',
    bank_account: '12-3456', payment_terms: 'Due within 14 days' };
}

// --- Context ---

const errors = [];
const toasts = [];

const cli = {
  console: { log: function() {}, warn: function() {}, error: function() {} },
  document: doc,
  window: { addEventListener: function() {}, location: { hash: '#dashboard' } },
  prompt: function() { return 'note'; },
  confirm: function() { return true; },
  alert: function() {},
  setTimeout: function(fn) { return 0; },
  clearTimeout: function() {},
  Promise: Promise,
  // hours.js fires a synthetic change event after rebuilding a select.
  Event: function Event(type) { this.type = type; },
  Intl: Intl,
  Date: Date,
  Math: Math,
  JSON: JSON,
  isNaN: isNaN,
  parseInt: parseInt,
  parseFloat: parseFloat,
  Number: Number,
  String: String,
  encodeURIComponent: encodeURIComponent
};
cli.globalThis = cli;
vm.createContext(cli);

const files = ['utils.js.html', 'app.js.html', 'dashboard.js.html', 'hours.js.html',
  'invoices.js.html', 'budget.js.html', 'accounts.js.html', 'settings.js.html'];

vm.runInContext(files.map(function(f) {
  const src = fs.readFileSync(path.join(ROOT, 'src/client/js', f), 'utf8');
  return /<script[^>]*>([\s\S]*?)<\/script>/.exec(src)[1];
}).join('\n'), cli, { filename: 'client-bundle.js' });

// Replace the stubs the modules need, AFTER loading (they declare `var`).
const unknownCalls = [];
cli.serverCall = function(name, args) {
  if (!Object.prototype.hasOwnProperty.call(RESPONSES, name)) {
    unknownCalls.push(name);
    return Promise.resolve(null);
  }
  const value = RESPONSES[name];
  return Promise.resolve(typeof value === 'function' ? value(args) : value);
};
cli.showToast = function(message, type) {
  toasts.push({ message: message, type: type || 'success' });
};
cli.AppCache.businesses = [BUSINESS];
cli.AppCache.workCodes = [WORK_CODE];
cli.AppCache.accounts = [ACCOUNT];
cli.AppCache.budgetRules = [RULE, LEGACY_RULE];
cli.AppCache.budgetCategories = BUDGET_CATEGORIES;
cli.AppCache.contracts = [CONTRACT];
cli.AppCache.myDetails = RESPONSES_MY_DETAILS();

process.on('unhandledRejection', function(err) {
  errors.push('unhandled rejection: ' + (err && err.message ? err.message : err));
});

// --- Harness ---

let failures = 0;
let passes = 0;

function check(label, cond, detail) {
  if (cond) {
    passes++;
    console.log('  ok    ' + label);
  } else {
    failures++;
    console.log('  FAIL  ' + label);
    if (detail) console.log('        ' + detail);
  }
}

/** Run a render entry point and report anything it threw or toasted. */
async function drive(label, fn) {
  const before = toasts.length;
  const thrown = [];
  try {
    fn();
  } catch (e) {
    thrown.push(e.message);
  }
  // Let the stubbed promise chains settle.
  for (let i = 0; i < 12; i++) await Promise.resolve();
  await new Promise(function(r) { setImmediate(r); });
  for (let i = 0; i < 12; i++) await Promise.resolve();

  const errorToasts = toasts.slice(before).filter(function(t) { return t.type === 'error'; });
  const problems = thrown.concat(errorToasts.map(function(t) { return 'toast: ' + t.message; }));
  check(label, problems.length === 0, problems.join(' | '));
}

(async function run() {
  console.log('\nPage render paths');
  const container = makeElement('div', 'app-content');

  await drive('dashboard', function() { cli.renderDashboardPage(container); });
  await drive('hours', function() { cli.renderHoursPage(container); });
  await drive('invoices', function() { cli.renderInvoicesPage(container); });
  await drive('budget', function() { cli.renderBudgetPage(container); });
  await drive('accounts', function() { cli.renderAccountsPage(container); });
  await drive('settings', function() { cli.renderSettingsPage(container); });

  console.log('\nTabs within pages');
  await drive('hours > expenses', function() { cli.showHoursTab('expenses'); });
  await drive('invoices > create', function() { cli.showInvoiceTab('create'); });
  await drive('invoices > list', function() { cli.showInvoiceTab('list'); });
  await drive('budget > allocate', function() { cli.showBudgetTab('allocate'); });
  await drive('budget > money flow', function() { cli.showBudgetTab('summary'); });
  for (const tab of ['mydetails', 'businesses', 'contracts', 'codes', 'accounts', 'rules']) {
    await drive('settings > ' + tab, function() { cli.showSettingsTab(tab); });
  }

  console.log('\nDetail and edit views');
  await drive('invoice detail', function() { cli.viewInvoice('BC0526'); });
  await drive('invoice edit', function() { cli.editInvoice('BC0526'); });
  await drive('business edit', function() { cli.editBusiness('BIZ-001'); });
  await drive('work code edit', function() { cli.editWorkCode('DEV'); });
  await drive('contract edit', function() { cli.editContract('CON-001'); });
  await drive('company rule edit', function() { cli.editBudgetRule('BR-001'); });
  await drive('legacy rule edit', function() { cli.editBudgetRule('BR-000'); });
  // Populate the pickers first — with empty fields both correctly refuse, which
  // would test the guard rather than the render path.
  doc.getElementById('ba-invoice').value = 'BC0526';
  doc.getElementById('ba-rule').value = 'BR-001';
  await drive('allocation preview', function() { cli.previewAllocation(); });

  console.log('\nRecording a payment');
  await drive('budget > money flow', function() { cli.showBudgetTab('summary'); });
  await drive('open the payment panel', function() {
    cli.openPayPanel('pay-host-obligations', 'biz_tax', 'Tax to pay', 'pay', 1400);
  });
  // Read off the markup, not the field: this DOM stub does not parse innerHTML
  // into elements, so a value written as an attribute never reaches .value.
  const panelHtml = doc.getElementById('pay-host-obligations').innerHTML;
  check('the panel prefills the full outstanding amount',
    panelHtml.indexOf('id="pay-amount" step="0.01" min="0.01" value="1400.00"') !== -1,
    panelHtml.slice(0, 200));
  check('the panel names the bucket and what is owed',
    panelHtml.indexOf('Pay: Tax to pay') !== -1 && panelHtml.indexOf('$1,400.00 outstanding') !== -1);
  check('the panel submits as a payment whatever the settle mode',
    panelHtml.indexOf('>Record payment</button>') !== -1);
  await drive('record a part payment', function() {
    doc.getElementById('pay-amount').value = '400';
    doc.getElementById('pay-date').value = '2026-06-05';
    doc.getElementById('pay-note').value = 'ASB 4471 | prov tax';
    cli.submitPayment();
  });
  // A held bucket: its panel must read the same as a paid-out one.
  await drive('the panel for a held bucket', function() {
    cli.openPayPanel('pay-host-allocations', 'per_save,legacy_save', 'Save', 'hold', 208.41);
  });
  const heldPanel = doc.getElementById('pay-host-allocations').innerHTML;
  check('a held bucket says Pay too',
    heldPanel.indexOf('Pay: Save') !== -1 &&
    heldPanel.indexOf('>Record payment</button>') !== -1 &&
    heldPanel.indexOf('Set aside') === -1);

  await drive('the full-remaining shortcut', function() {
    cli.openPayPanel('pay-host-obligations', 'biz_tax', 'Tax to pay', 'pay', 1400);
    doc.getElementById('pay-amount').value = '1';
    cli.payFullRemaining();
  });
  check('the shortcut fills in the outstanding amount',
    doc.getElementById('pay-amount').value === '1400.00',
    'got ' + doc.getElementById('pay-amount').value);
  await drive('cancel closes the panel', function() { cli.closePayPanel(); });
  await drive('undo a payment', function() { cli.undoPayment('BP-001'); });
  await drive('remove an allocation', function() { cli.removeAllocation('BC0526'); });

  // Both must refuse before reaching the server, so the error is immediate.
  const beforeRefusals = toasts.length;
  cli.openPayPanel('pay-host-obligations', 'biz_tax', 'Tax to pay', 'pay', 1400);
  doc.getElementById('pay-amount').value = '0';
  cli.submitPayment();
  doc.getElementById('pay-amount').value = '99999';
  cli.submitPayment();
  const refusals = toasts.slice(beforeRefusals).filter(function(t) { return t.type === 'error'; });
  check('a zero and an over-payment are both refused client-side',
    refusals.length === 2, 'got ' + refusals.length + ' refusals');
  cli.closePayPanel();

  doc.getElementById('inv-business').value = 'BIZ-001';
  doc.getElementById('inv-from').value = '2026-05-01';
  doc.getElementById('inv-to').value = '2026-05-31';
  doc.getElementById('inv-gst-rate').value = '15';
  await drive('invoice preview', function() { cli.previewInvoice(); });
  await drive('allocation preview refuses empty input', function() {
    doc.getElementById('ba-invoice').value = '';
    const before = toasts.length;
    cli.previewAllocation();
    if (toasts.length === before) throw new Error('expected a validation toast');
    toasts.splice(before, toasts.length - before);
    doc.getElementById('ba-invoice').value = 'BC0526';
  });
  await drive('invoice date presets', function() {
    cli.setInvoiceRange('lastMonth');
    cli.setInvoiceRange('month');
  });

  console.log('\nOverall');
  check('no unhandled promise rejections', errors.length === 0, errors.join(' | '));
  check('every serverCall the client made has a fixture',
    unknownCalls.length === 0,
    'unstubbed: ' + Array.from(new Set(unknownCalls)).join(', '));

  console.log('\n' + passes + ' passed, ' + failures + ' failed');
  process.exit(failures > 0 ? 1 : 0);
})();

#!/usr/bin/env node
/**
 * Does the money add up? An independent audit of the accounting, end to end.
 *
 *   node tools/check-reconciliation.js
 *
 * The other check scripts assert that particular functions return particular
 * figures. This one asserts the IDENTITIES those figures have to satisfy, over
 * a whole book of invoices, without restating how any of them is calculated:
 *
 *   1. Cascade   — every allocation set accounts for exactly the money billed,
 *                  across hundreds of generated amounts and rules.
 *   2. Book      — revenue less obligations equals what is left, and the
 *                  personal pot equals its four buckets.
 *   3. Payments  — every dollar counted as paid is either a recorded payment
 *                  or was withheld at source. Nothing else can create one.
 *   4. Reversal  — undoing every payment returns the book to exactly where it
 *                  started, to the cent.
 *   5. Screens   — the Dashboard and the Money Flow page agree on every
 *                  bucket, and the money map agrees with the sections below it.
 *
 * A failure here means money is being created or lost somewhere, which is the
 * one class of bug this app cannot be allowed to have.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

// --- Harness ---

let failures = 0;
let passes = 0;

function check(name, fn) {
  try {
    fn();
    passes++;
    console.log('  ok    ' + name);
  } catch (e) {
    failures++;
    console.log('  FAIL  ' + name);
    console.log('        ' + e.message);
  }
}

function exact(actual, expected, msg) {
  if (r2(actual) !== r2(expected)) {
    throw new Error((msg ? msg + ': ' : '') + 'expected ' + r2(expected) + ', got ' + r2(actual) +
      ' (out by ' + r2(actual - expected) + ')');
  }
}

function eq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error((msg ? msg + ': ' : '') + 'expected ' + JSON.stringify(expected) +
      ', got ' + JSON.stringify(actual));
  }
}

function section(t) { console.log('\n' + t); }
function r2(n) { return Math.round(Number(n) * 100) / 100; }

/** Deterministic pseudo-random, so a failure is always reproducible. */
function lcg(seed) {
  let s = seed >>> 0;
  return function() {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// --- The spreadsheet the server talks to ---

function makeSheet(name, headers, rows) {
  const grid = [headers.slice()].concat((rows || []).map(function(r) { return r.slice(); }));
  const sheet = {
    getName: function() { return name; },
    getLastRow: function() { return grid.length; },
    getLastColumn: function() {
      return grid.reduce(function(m, r) { return Math.max(m, r.length); }, 0);
    },
    setFrozenRows: function() { return this; },
    _grid: grid,
    deleteRow: function(rowIndex) { grid.splice(rowIndex - 1, 1); },
    getDataRange: function() { return sheet.getRange(1, 1, grid.length, sheet.getLastColumn()); },
    getRange: function(row, col, numRows, numCols) {
      numRows = numRows || 1;
      numCols = numCols || 1;
      return {
        getValues: function() {
          const out = [];
          for (let r = 0; r < numRows; r++) {
            const line = [];
            for (let c = 0; c < numCols; c++) {
              const gridRow = grid[row - 1 + r] || [];
              const v = gridRow[col - 1 + c];
              line.push(v === undefined ? '' : v);
            }
            out.push(line);
          }
          return out;
        },
        setValues: function(values) {
          values.forEach(function(line, r) {
            const target = row - 1 + r;
            while (grid.length <= target) grid.push([]);
            if (!grid[target]) grid[target] = [];
            line.forEach(function(v, c) { grid[target][col - 1 + c] = v; });
          });
          return this;
        },
        setValue: function(v) { return this.setValues([[v]]); },
        setNumberFormat: function() { return this; },
        setFontWeight: function() { return this; },
        setBackground: function() { return this; },
        setFontColor: function() { return this; }
      };
    }
  };
  return sheet;
}

const app = {
  Logger: { log: function() {} },
  LockService: { getScriptLock: function() { return { waitLock: function() {}, releaseLock: function() {} }; } },
  SpreadsheetApp: { getActiveSpreadsheet: function() { return app.__ss; } }
};
vm.createContext(app);
vm.runInContext(['BudgetCategories.gs', 'BudgetService.gs', 'SheetService.gs', 'Setup.gs',
  'IdService.gs', 'InvoiceService.gs', 'SettingsService.gs', 'ContractService.gs',
  'HoursService.gs', 'DashboardService.gs', 'AccountService.gs', 'ClientWrappers.gs']
  .map(function(f) { return fs.readFileSync(path.join(ROOT, 'src', 'server', f), 'utf8'); })
  .join('\n'), app, { filename: 'reconciliation.js' });

function build(data) {
  const schemas = app.sheetSchemas();
  const sheets = {};
  Object.keys(schemas).forEach(function(name) {
    const cols = schemas[name];
    const rows = (data[name] || []).map(function(obj) {
      return cols.map(function(c) { return obj[c] === undefined ? '' : obj[c]; });
    });
    sheets[name] = makeSheet(name, cols, rows);
  });
  app.__ss = {
    getSheets: function() { return Object.keys(sheets).map(function(k) { return sheets[k]; }); },
    getSheetByName: function(n) { return sheets[n] || null; },
    insertSheet: function(n) { sheets[n] = makeSheet(n, [], []); return sheets[n]; },
    deleteSheet: function(s) { delete sheets[s.getName()]; }
  };
  return sheets;
}

// --- The client's own summing helpers, so the page maths is audited too ---

const cli = {
  console: console,
  document: { getElementById: function() { return null; } },
  prompt: function() { return null; },
  confirm: function() { return true; }
};
cli.serverCall = function() { return Promise.resolve(null); };
vm.createContext(cli);
vm.runInContext(['utils.js.html', 'budget.js.html', 'dashboard.js.html'].map(function(f) {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'client', 'js', f), 'utf8');
  return /<script[^>]*>([\s\S]*?)<\/script>/.exec(src)[1];
}).join('\n'), cli, { filename: 'reconciliation-client.js' });

// =====================================================================
// 1. The cascade accounts for exactly the money billed
// =====================================================================

section('Every allocation set accounts for exactly what was billed');

/** A rule whose distribution sums to exactly 100%, as the app requires. */
function randomRule(rand) {
  const parts = [rand(), rand(), rand(), rand()];
  const sum = parts.reduce(function(a, b) { return a + b; }, 0);
  // Three rounded shares and an exact remainder, so the four sum to 1 exactly.
  const donate = Math.round(parts[0] / sum * 1000) / 1000;
  const save = Math.round(parts[1] / sum * 1000) / 1000;
  const invest = Math.round(parts[2] / sum * 1000) / 1000;
  const spend = Math.round((1 - donate - save - invest) * 1000) / 1000;

  return {
    rule_id: 'BR-X', name: 'Generated', model: 'company', is_default: true, active: true,
    biz_tax_withheld_pct: Math.round(rand() * 0.2 * 1000) / 1000,
    biz_acc_withheld_pct: Math.round(rand() * 0.05 * 1000) / 1000,
    biz_tax_pct: Math.round(rand() * 0.4 * 1000) / 1000,
    biz_acc_pct: Math.round(rand() * 0.05 * 1000) / 1000,
    biz_reserve_pct: Math.round(rand() * 0.3 * 1000) / 1000,
    per_tax_pct: Math.round(rand() * 0.4 * 1000) / 1000,
    per_acc_pct: Math.round(rand() * 0.05 * 1000) / 1000,
    per_donate_pct: donate, per_save_pct: save, per_invest_pct: invest, per_spend_pct: spend,
    // The legacy fields, for the sole-trader cascade over the same shape.
    tax_withheld_pct: Math.round(rand() * 0.2 * 1000) / 1000,
    acc_withheld_pct: Math.round(rand() * 0.05 * 1000) / 1000,
    tax_to_pay_pct: Math.round(rand() * 0.4 * 1000) / 1000,
    acc_to_pay_pct: Math.round(rand() * 0.05 * 1000) / 1000,
    donate_pct: donate, save_pct: save, invest_pct: invest, spend_pct: spend
  };
}

const CASES = 400;

check('company: the lines sum to billed hours + GST, to the cent, every time', function() {
  const rand = lcg(20260922);
  let worst = 0, worstAt = null;

  for (let i = 0; i < CASES; i++) {
    // Awkward amounts on purpose: thirds, long decimals, tiny and large.
    const gross = r2([1, 33.33, 158.73, 999.99, 4200, 12000.005, 87654.32][i % 7] * (1 + rand() * 3));
    const gst = r2(gross * 0.15);
    const rule = randomRule(rand);

    const plan = app.computeCompanyAllocation(rule, gross, gst);
    const summed = r2(plan.lines.reduce(function(s, l) {
      return l.isTransfer ? s : s + l.amount;
    }, 0));

    const drift = Math.abs(summed - r2(gross + gst));
    if (drift > worst) { worst = drift; worstAt = { gross: gross, gst: gst, summed: summed }; }
  }
  eq(worst, 0, 'largest drift over ' + CASES + ' cases' +
    (worstAt ? ' (' + JSON.stringify(worstAt) + ')' : ''));
});

check('company: owner pay is exactly what the business did not keep', function() {
  const rand = lcg(7);
  for (let i = 0; i < CASES; i++) {
    const gross = r2(500 + rand() * 50000);
    const rule = randomRule(rand);
    const s = app.computeCompanyAllocation(rule, gross, r2(gross * 0.15)).stages;
    exact(s.ownerPay, s.businessIncome - s.businessObligations, 'owner pay at gross ' + gross);
    exact(s.businessIncome, s.gross - s.withheld, 'business income at gross ' + gross);
  }
});

check('company: the personal buckets sum back to owner pay', function() {
  const rand = lcg(99);
  for (let i = 0; i < CASES; i++) {
    const gross = r2(500 + rand() * 50000);
    const rule = randomRule(rand);
    const plan = app.computeCompanyAllocation(rule, gross, r2(gross * 0.15));
    const personal = r2(plan.lines.filter(function(l) { return l.scope === 'personal'; })
      .reduce(function(s, l) { return s + l.amount; }, 0));
    exact(personal, plan.stages.ownerPay, 'personal total at gross ' + gross);
  }
});

check('company: the four distribution buckets sum to personal net exactly', function() {
  const rand = lcg(4242);
  for (let i = 0; i < CASES; i++) {
    const gross = r2(500 + rand() * 50000);
    const rule = randomRule(rand);
    const plan = app.computeCompanyAllocation(rule, gross, 0);
    const dist = r2(plan.lines.filter(function(l) { return l.group === 'personal_distribution'; })
      .reduce(function(s, l) { return s + l.amount; }, 0));
    exact(dist, plan.stages.personalNet, 'distribution at gross ' + gross);
  }
});

check('sole trader: the legacy cascade conserves too', function() {
  const rand = lcg(31337);
  let worst = 0, worstAt = null;

  for (let i = 0; i < CASES; i++) {
    const gross = r2([1, 33.33, 158.73, 999.99, 4200, 12000.005, 87654.32][i % 7] * (1 + rand() * 3));
    const gst = r2(gross * 0.15);
    const rule = randomRule(rand);

    const plan = app.computeLegacyAllocation(rule, gross, gst);
    const summed = r2(plan.lines.reduce(function(s, l) { return s + l.amount; }, 0));

    const drift = Math.abs(summed - r2(gross + gst));
    if (drift > worst) { worst = drift; worstAt = { gross: gross, summed: summed, expected: r2(gross + gst) }; }
  }
  eq(worst, 0, 'largest drift over ' + CASES + ' cases' +
    (worstAt ? ' (' + JSON.stringify(worstAt) + ')' : ''));
});

check('a zero invoice allocates nothing rather than a set of zeroes', function() {
  const plan = app.computeCompanyAllocation(randomRule(lcg(1)), 0, 0);
  exact(plan.total, 0, 'total');
  eq(plan.lines.every(function(l) { return l.amount === 0; }), true, 'every line zero');
});

// =====================================================================
// 2. A whole book of invoices
// =====================================================================

section('A book of invoices reconciles from every angle');

const COMPANY_RULE = {
  rule_id: 'BR-001', name: 'Company Default', model: 'company', is_default: true, active: true,
  biz_tax_withheld_pct: 0.05, biz_acc_withheld_pct: 0.01,
  biz_tax_pct: 0.28, biz_acc_pct: 0.01, biz_reserve_pct: 0.10,
  per_tax_pct: 0.30, per_acc_pct: 0.0167,
  per_donate_pct: 0.05, per_save_pct: 0.10, per_invest_pct: 0.15, per_spend_pct: 0.70
};

const LEGACY_RULE = {
  rule_id: 'BR-000', name: 'Old Split', model: 'sole_trader', is_default: false, active: true,
  tax_withheld_pct: 0.10, tax_to_pay_pct: 0.28, acc_withheld_pct: 0, acc_to_pay_pct: 0.02,
  donate_pct: 0.05, save_pct: 0.10, invest_pct: 0.15, spend_pct: 0.70
};

const RANGE = { dateFrom: '2026-01-01', dateTo: '2026-12-31' };

/**
 * Deliberately awkward: two clients, GST on some invoices and not others,
 * amounts that do not divide cleanly, and a pre-company invoice on the legacy
 * cascade alongside company ones.
 */
const BOOK = [
  { id: 'AT0226', biz: 'BIZ-001', date: '2026-02-28', time: 3333.33, exp: 0, gst: true, rule: 'BR-000' },
  { id: 'AT0326', biz: 'BIZ-001', date: '2026-03-31', time: 12000, exp: 240.50, gst: true, rule: 'BR-001' },
  { id: 'KE0426', biz: 'BIZ-002', date: '2026-04-30', time: 158.73, exp: 0, gst: false, rule: 'BR-001' },
  { id: 'AT0526', biz: 'BIZ-001', date: '2026-05-31', time: 9600.01, exp: 1000, gst: true, rule: 'BR-001' },
  { id: 'KE0626', biz: 'BIZ-002', date: '2026-06-30', time: 4200, exp: 0, gst: true, rule: 'BR-001' },
  { id: 'KE0726', biz: 'BIZ-002', date: '2026-07-31', time: 77.77, exp: 33.33, gst: true, rule: 'BR-001' }
];

function buildBook() {
  build({
    Businesses: [
      { business_id: 'BIZ-001', name: 'Auckland Transport', currency: 'NZD', active: true },
      { business_id: 'BIZ-002', name: 'Kaipara Estuary Trust', currency: 'NZD', active: true }
    ],
    BudgetRules: [COMPANY_RULE, LEGACY_RULE],
    Invoices: BOOK.map(function(b) {
      const gst = b.gst ? r2(b.time * 0.15) : 0;
      return {
        invoice_id: b.id, business_id: b.biz, date_from: b.date, date_to: b.date,
        created_date: b.date, include_gst: b.gst, gst_rate: b.gst ? 0.15 : 0,
        time_subtotal: b.time, subtotal: r2(b.time + b.exp), gst_amount: gst,
        total: r2(b.time + b.exp + gst), status: 'paid', budget_rule_id: '',
        contract_id: '', po_number: '', description: '', notes: '', line_descriptions: ''
      };
    })
  });
  BOOK.forEach(function(b) { app.allocateBudget(b.id, b.rule); });
}

/** What the invoices themselves say was billed for time, plus GST. */
function billedPlusGst() {
  return r2(BOOK.reduce(function(s, b) {
    return s + b.time + (b.gst ? r2(b.time * 0.15) : 0);
  }, 0));
}

check('every invoice allocates exactly its billed hours plus GST', function() {
  buildBook();
  const byInvoice = {};
  app.getAll('BudgetAllocations').forEach(function(a) {
    const def = app.getCategoryDef(app.resolveCategoryKey(a));
    if (def && def.isTransfer) return;
    const k = String(a.invoice_id);
    byInvoice[k] = r2((byInvoice[k] || 0) + (Number(a.amount) || 0));
  });

  BOOK.forEach(function(b) {
    const expected = r2(b.time + (b.gst ? r2(b.time * 0.15) : 0));
    exact(byInvoice[b.id], expected, b.id + ' (expenses are pass-throughs and excluded)');
  });
});

check('expenses are billed to the client but never allocated', function() {
  buildBook();
  const allocated = r2(app.getAll('BudgetAllocations').reduce(function(s, a) {
    const def = app.getCategoryDef(app.resolveCategoryKey(a));
    if (def && def.isTransfer) return s;
    return s + (Number(a.amount) || 0);
  }, 0));
  const invoiced = r2(app.getAll('Invoices').reduce(function(s, i) { return s + Number(i.total); }, 0));
  const expenses = r2(BOOK.reduce(function(s, b) { return s + b.exp; }, 0));

  exact(allocated, billedPlusGst(), 'allocated');
  exact(invoiced - allocated, expenses, 'the gap between invoiced and allocated is exactly the expenses');
});

check('revenue less obligations equals what is left, on the page maths', function() {
  buildBook();
  const summary = app.getBudgetSummary(RANGE);
  const cats = cli.catByKey(summary);

  const view = cli.revenueViews(summary, cats);
  const invoicedRevenue = r2(view.business.total + view.soleTrader.total);

  const obligations = cli.sumCats(cats,
    cli.keysOf(cli.BIZ_OBLIGATIONS.concat(cli.PERSONAL_OBLIGATIONS))).allocated;
  const reserve = cli.catOf(cats, 'biz_reserve').allocated;
  const pot = cli.sumCats(cats, cli.keysOf(cli.PERSONAL_ALLOCATIONS)).allocated;

  exact(invoicedRevenue, billedPlusGst(), 'revenue equals what was billed');
  exact(invoicedRevenue - obligations, reserve + pot,
    'revenue - obligations = reserve + personal pot');
});

check('the personal pot is exactly its four buckets', function() {
  buildBook();
  const cats = cli.catByKey(app.getBudgetSummary(RANGE));
  const pot = cli.sumCats(cats, cli.keysOf(cli.PERSONAL_ALLOCATIONS)).allocated;
  const four = cli.PERSONAL_ALLOCATIONS.reduce(function(s, row) {
    return s + cli.sumCats(cats, row.keys).allocated;
  }, 0);
  exact(pot, four, 'pot');
});

check('the owner pay draw never counts as revenue on either side', function() {
  buildBook();
  const summary = app.getBudgetSummary(RANGE);
  const cats = cli.catByKey(summary);
  const naive = r2((summary.scopes || []).reduce(function(s, g) {
    return s + (g.categories || []).reduce(function(t, c) { return t + c.allocated; }, 0);
  }, 0));
  const view = cli.revenueViews(summary, cats);
  exact(naive - (view.business.total + view.soleTrader.total), summary.bridge.allocated,
    'the only thing excluded is the draw');
});

check('every bucket a payment can target has a home on the page', function() {
  buildBook();
  const summary = app.getBudgetSummary(RANGE);
  const onPage = {};
  cli.keysOf(cli.BIZ_OBLIGATIONS.concat(cli.PERSONAL_OBLIGATIONS).concat(cli.PERSONAL_ALLOCATIONS))
    .forEach(function(k) { onPage[k] = true; });
  onPage.biz_reserve = true;
  onPage.owner_pay = true;

  const missing = [];
  (summary.scopes || []).forEach(function(g) {
    (g.categories || []).forEach(function(c) {
      if (!onPage[c.key]) missing.push(c.key + ' (' + app.round2(c.allocated) + ')');
    });
  });
  eq(missing.join(', '), '', 'buckets with money but no box');
});

// =====================================================================
// 3. Payments cannot create or lose money
// =====================================================================

section('Every dollar counted as paid can be accounted for');

/** Paid across the whole book, and the part of it that was withheld at source. */
function paidTotals() {
  let paid = 0, withheld = 0;
  app.getAll('BudgetAllocations').forEach(function(a) {
    const def = app.getCategoryDef(app.resolveCategoryKey(a));
    const p = app.allocationPaidAmount(a);
    paid += p;
    if (def && def.settle === 'auto_paid') withheld += p;
  });
  return { paid: r2(paid), withheld: r2(withheld) };
}

function paymentsTotal() {
  return r2(app.getAll('BudgetPayments').reduce(function(s, p) { return s + Number(p.amount); }, 0));
}

check('before any payment, the only paid money is what was withheld', function() {
  buildBook();
  const t = paidTotals();
  exact(t.paid, t.withheld, 'paid');
  eq(t.withheld > 0, true, 'the book actually withholds something');
  exact(paymentsTotal(), 0, 'payments recorded');
});

const PAYMENTS = [
  ['biz_gst,legacy_gst', 500],
  ['biz_tax', 1234.56],
  ['per_tax,legacy_tax', 0.01],
  ['owner_pay', 2500],
  ['per_save,legacy_save', 77.77],
  ['biz_reserve', 333.33],
  ['per_spend,legacy_spend', 1000]
];

function payAll() {
  PAYMENTS.forEach(function(p, i) {
    app.payBudgetCategories(p[0], p[1], '2026-08-' + String(i + 1).padStart(2, '0'), '', RANGE);
  });
}

check('after payments, paid equals withheld plus exactly what was paid', function() {
  buildBook();
  const before = paidTotals();
  payAll();
  const after = paidTotals();

  exact(paymentsTotal(), PAYMENTS.reduce(function(s, p) { return s + p[1]; }, 0),
    'the payments sheet records what was asked for');
  exact(after.paid, before.withheld + paymentsTotal(),
    'paid = withheld + payments — nothing else can make a dollar paid');
  exact(after.withheld, before.withheld, 'withholding is untouched by paying');
});

check('a payment moves money from outstanding to paid and nowhere else', function() {
  buildBook();
  const summary = function() { return app.getBudgetSummary(RANGE).totals; };
  const before = summary();
  payAll();
  const after = summary();

  // The totals exclude the owner pay draw — it is a transfer between two of
  // your own accounts, so counting it would double every personal dollar — and
  // that exclusion applies to paying it too.
  const drawPayments = r2(PAYMENTS.filter(function(p) { return p[0] === 'owner_pay'; })
    .reduce(function(s, p) { return s + p[1]; }, 0));
  const counted = r2(paymentsTotal() - drawPayments);

  eq(drawPayments > 0, true, 'a draw payment is actually in the set');
  exact(after.allocated, before.allocated, 'allocated is unchanged by paying');
  exact(after.paid - before.paid, counted, 'paid rises by the payments that are not the draw');
  exact(before.outstanding - after.outstanding, counted, 'outstanding falls by the same');
  exact(after.allocated, after.paid + after.outstanding, 'allocated = paid + outstanding');
});

check('paying the draw moves the bridge and leaves the totals alone', function() {
  buildBook();
  const before = app.getBudgetSummary(RANGE);
  app.payBudgetCategories('owner_pay', 2500, '2026-08-01', '', RANGE);
  const after = app.getBudgetSummary(RANGE);

  exact(after.bridge.paid - before.bridge.paid, 2500, 'the bridge records it');
  exact(after.totals.paid, before.totals.paid, 'the totals do not');
});

check('a payment never spills past the bucket it was aimed at', function() {
  buildBook();
  const before = app.getBudgetSummary(RANGE);
  app.payBudgetCategories('biz_tax', 1000, '2026-08-01', '', RANGE);
  const after = app.getBudgetSummary(RANGE);

  function byKey(sum) {
    const m = {};
    (sum.scopes || []).forEach(function(g) {
      (g.categories || []).forEach(function(c) { m[c.key] = c; });
    });
    return m;
  }
  const b = byKey(before), a = byKey(after);
  Object.keys(b).forEach(function(k) {
    if (k === 'biz_tax') return;
    exact(a[k].paid, b[k].paid, k + ' paid');
    exact(a[k].outstanding, b[k].outstanding, k + ' outstanding');
  });
  exact(a.biz_tax.paid - b.biz_tax.paid, 1000, 'biz_tax paid');
});

check('paying every bucket to the cent leaves nothing outstanding and nothing over', function() {
  buildBook();
  const summary = app.getBudgetSummary(RANGE);
  const cats = cli.catByKey(summary);

  // Pay the exact remaining amount of every payable bucket on the page.
  const rows = cli.BIZ_OBLIGATIONS.concat(cli.PERSONAL_OBLIGATIONS)
    .concat(cli.PERSONAL_ALLOCATIONS)
    .concat([{ label: 'Reserve', keys: ['biz_reserve'] }, { label: 'Draw', keys: ['owner_pay'] }]);

  rows.forEach(function(row) {
    const keys = cli.payableKeys(row.keys);
    const owed = cli.sumCats(cats, keys).outstanding;
    if (owed > 0) app.payBudgetCategories(keys, owed, '2026-08-31', '', RANGE);
  });

  const after = app.getBudgetSummary(RANGE).totals;
  exact(after.outstanding, 0, 'outstanding after paying everything');
  exact(after.paid, after.allocated, 'paid equals allocated');
});

// =====================================================================
// 4. Reversal
// =====================================================================

section('Undoing every payment returns the book exactly where it started');

check('undo restores allocated, paid and outstanding to the cent', function() {
  buildBook();
  const before = app.getBudgetSummary(RANGE).totals;
  payAll();
  app.getAll('BudgetPayments').slice().forEach(function(p) {
    app.undoBudgetPayment(p.payment_id);
  });
  const after = app.getBudgetSummary(RANGE).totals;

  exact(after.allocated, before.allocated, 'allocated');
  exact(after.paid, before.paid, 'paid');
  exact(after.outstanding, before.outstanding, 'outstanding');
  eq(app.getAll('BudgetPayments').length, 0, 'payments left');
});

check('undo restores every bucket individually, not just the totals', function() {
  buildBook();
  function byKey() {
    const m = {};
    (app.getBudgetSummary(RANGE).scopes || []).forEach(function(g) {
      (g.categories || []).forEach(function(c) {
        m[c.key] = { paid: c.paid, outstanding: c.outstanding };
      });
    });
    return m;
  }
  const before = byKey();
  payAll();
  app.getAll('BudgetPayments').slice().forEach(function(p) { app.undoBudgetPayment(p.payment_id); });
  const after = byKey();

  Object.keys(before).forEach(function(k) {
    exact(after[k].paid, before[k].paid, k + ' paid');
    exact(after[k].outstanding, before[k].outstanding, k + ' outstanding');
  });
});

check('removing an allocation removes exactly that invoice and no other money', function() {
  buildBook();
  const before = app.getBudgetSummary(RANGE).totals;
  const target = BOOK[1];
  const targetTotal = r2(target.time + (target.gst ? r2(target.time * 0.15) : 0));

  app.deallocateInvoice(target.id);
  const after = app.getBudgetSummary(RANGE).totals;

  exact(before.allocated - after.allocated, targetTotal,
    'the book drops exactly that invoice');
  eq(app.getAll('BudgetAllocations').some(function(a) {
    return String(a.invoice_id) === target.id;
  }), false, 'no rows left for it');
});

// =====================================================================
// 5. The screens agree
// =====================================================================

section('The Dashboard and the Money Flow page agree on every bucket');

check('before and after payments, for every bucket the Dashboard shows', function() {
  buildBook();
  payAll();

  const dash = app.getDashboardData(RANGE);
  const cats = cli.catByKey(app.getBudgetSummary(RANGE));

  eq((dash.budget || []).length > 0, true, 'the tile has buckets to show');
  (dash.budget || []).forEach(function(tile) {
    const bucket = cli.catOf(cats, tile.key);
    exact(tile.allocated, bucket.allocated, tile.key + ' allocated');
    exact(tile.paid, bucket.paid, tile.key + ' paid');
    exact(tile.outstanding, bucket.outstanding, tile.key + ' outstanding');
  });
});

/**
 * The figures the money map actually puts on screen, read back off the markup.
 *
 * Read from the rendered HTML rather than by calling the same helpers the
 * renderer calls: the point is that the page balances, and a check that
 * re-derives the numbers its own way would still pass if the renderer stopped
 * using them.
 */
function renderedMap(summary, cats) {
  const html = cli.renderMoneyMap(summary, cats);
  const amounts = Array.from(html.matchAll(/money-map__line-amount">([^<]+)</g))
    .map(function(m) { return r2(Number(m[1].replace(/[^0-9.-]/g, ''))); });
  const bridge = /money-map__bridge-amount">([^<]+)</.exec(html);

  if (amounts.length !== 6 || !bridge) {
    throw new Error('the map no longer renders three lines a side plus a bridge, got ' +
      amounts.length + ' lines');
  }
  return {
    business: { in: amounts[0], owed: amounts[1], reserve: amounts[2] },
    draw: r2(Number(bridge[1].replace(/[^0-9.-]/g, ''))),
    personal: { in: amounts[3], owed: amounts[4], toAllocate: amounts[5] }
  };
}

check('the money map balances, as rendered', function() {
  buildBook();
  payAll();

  const summary = app.getBudgetSummary(RANGE);
  const cats = cli.catByKey(summary);
  const map = renderedMap(summary, cats);

  exact(map.business.in - map.business.owed - map.business.reserve, map.draw,
    'business in, less obligations and reserve, is the draw');
  exact(map.personal.in - map.personal.owed, map.personal.toAllocate,
    'personal in, less obligations, is what there is to allocate');
});

check('the map agrees with the sections beneath it', function() {
  buildBook();
  payAll();

  const summary = app.getBudgetSummary(RANGE);
  const cats = cli.catByKey(summary);
  const map = renderedMap(summary, cats);
  const view = cli.revenueViews(summary, cats);

  exact(map.business.in, view.business.total, 'business revenue');
  exact(map.personal.in, view.personal.total, 'personal revenue');
  exact(map.draw, cli.catOf(cats, 'owner_pay').allocated, 'the draw');
  exact(map.business.reserve, cli.catOf(cats, 'biz_reserve').allocated, 'the reserve pot');
  // The map's "to allocate" and the Allocations section's total are the same
  // money reached two different ways, so they must never disagree.
  exact(map.personal.toAllocate, cli.sumCats(cats, cli.keysOf(cli.PERSONAL_ALLOCATIONS)).allocated,
    'the pot');
});

check('the map balances even when a sole-trader invoice carried GST', function() {
  buildBook();
  const summary = app.getBudgetSummary(RANGE);
  // The book's first invoice is on the legacy cascade WITH GST, which is the
  // case that used to break the business column: its GST is shown in the
  // Business GST box, but the money sat in the personal account.
  eq(cli.sumCats(cli.catByKey(summary), ['legacy_gst']).allocated > 0, true,
    'the book actually has sole-trader GST');

  const cats = cli.catByKey(summary);
  const sectionBizOwed = cli.sumCats(cats, cli.keysOf(cli.BIZ_OBLIGATIONS)).allocated;
  const mapBizOwed = renderedMap(summary, cats).business.owed;
  exact(sectionBizOwed - mapBizOwed, cli.sumCats(cats, ['legacy_gst']).allocated,
    'the only difference between the GST box and the business column is the sole-trader GST');
});

check('withheld tax raises Paid without raising what is owed', function() {
  buildBook();
  const cats = cli.catByKey(app.getBudgetSummary(RANGE));

  const withheldInPersonalTax = cli.sumCats(cats, ['legacy_tax_withheld']).allocated;
  eq(withheldInPersonalTax > 0, true, 'the book withholds personal tax');

  const row = cli.PERSONAL_OBLIGATIONS[0];
  const withRow = cli.sumCats(cats, row.keys);
  const withoutWithheld = cli.sumCats(cats, cli.payableKeys(row.keys));

  exact(withRow.outstanding, withoutWithheld.outstanding,
    'what is still to pay is the same either way');
  exact(withRow.paid - withoutWithheld.paid, withheldInPersonalTax,
    'the whole difference in Paid is the withheld amount');
  exact(withRow.allocated - withoutWithheld.allocated, withheldInPersonalTax,
    'and so is the difference in the total');
});

// =====================================================================
// 6. The invoice itself
// =====================================================================

section('An invoice adds up before anything is allocated from it');

check('subtotal, GST and total agree, with GST on services only', function() {
  build({
    Businesses: [{ business_id: 'BIZ-001', name: 'Auckland Transport', currency: 'NZD', active: true }],
    WorkCodes: [{ code_id: 'DEV', description: 'Dev', category: 'billable', active: true }],
    TimeEntries: [
      { entry_id: 'TE-001', business_id: 'BIZ-001', date: '2026-05-04', time_start: '09:00',
        time_end: '17:00', hours: 8, description: 'x', work_code: 'DEV', rate: 137.77,
        line_total: r2(8 * 137.77), invoice_id: '', contract_id: '' },
      { entry_id: 'TE-002', business_id: 'BIZ-001', date: '2026-05-05', time_start: '09:00',
        time_end: '12:30', hours: 3.5, description: 'y', work_code: 'DEV', rate: 137.77,
        line_total: r2(3.5 * 137.77), invoice_id: '', contract_id: '' }
    ],
    Expenses: [{ expense_id: 'EXP-001', business_id: 'BIZ-001', date: '2026-05-06',
      amount: 233.33, description: 'Flights', work_code: 'DEV', invoice_id: '' }]
  });

  const inv = app.generateInvoice({ businessId: 'BIZ-001', dateFrom: '2026-05-01',
    dateTo: '2026-05-31', includeGst: true, gstRate: 0.15 });

  const time = r2(r2(8 * 137.77) + r2(3.5 * 137.77));
  exact(inv.time_subtotal, time, 'billed time');
  exact(inv.subtotal, time + 233.33, 'subtotal includes the expense');
  exact(inv.gst_amount, r2(time * 0.15), 'GST is on services only, never on the expense');
  exact(inv.total, inv.subtotal + inv.gst_amount, 'total');
});

check('the printed line items sum to the services subtotal', function() {
  build({
    Businesses: [{ business_id: 'BIZ-001', name: 'Auckland Transport', currency: 'NZD', active: true }],
    WorkCodes: [
      { code_id: 'DEV', description: 'Dev', category: 'billable', active: true },
      { code_id: 'ADV', description: 'Advisory', category: 'billable', active: true }
    ],
    TimeEntries: [
      ['TE-001', 'DEV', 137.77, 8], ['TE-002', 'DEV', 149.99, 3.5],
      ['TE-003', 'ADV', 210, 1.25], ['TE-004', 'ADV', 210, 0.75]
    ].map(function(r, i) {
      return {
        entry_id: r[0], business_id: 'BIZ-001', date: '2026-05-0' + (i + 1),
        time_start: '09:00', time_end: '10:00', hours: r[3], description: 'x',
        work_code: r[1], rate: r[2], line_total: r2(r[3] * r[2]), invoice_id: '', contract_id: ''
      };
    })
  });
  app.generateInvoice({ businessId: 'BIZ-001', dateFrom: '2026-05-01', dateTo: '2026-05-31',
    includeGst: true, gstRate: 0.15 });

  const details = app.getInvoiceDetails('AT0526');
  const lineSum = r2(details.codeGroups.reduce(function(s, g) { return s + g.totalAmount; }, 0));
  exact(lineSum, details.invoice.time_subtotal, 'the printed lines account for all billed time');
  details.codeGroups.forEach(function(g) {
    exact(r2(g.totalHours * g.rate), g.totalAmount,
      g.code + ' @ ' + g.rate + ': hours x rate must equal the amount shown');
  });
});

check('the Dashboard hours table adds up, per currency', function() {
  const entries = [
    { business_id: 'BIZ-001', hours: 8, line_total: 1102.16 },
    { business_id: 'BIZ-001', hours: 3.5, line_total: 482.20 },
    { business_id: 'BIZ-002', hours: 4, line_total: 600 }
  ];
  const invoices = [
    { business_id: 'BIZ-001', time_subtotal: 1584.36, status: 'paid' },
    { business_id: 'BIZ-002', time_subtotal: 600, status: 'paid' },
    { business_id: 'BIZ-002', time_subtotal: 9999, status: 'void' }
  ];
  const bizMap = {
    'BIZ-001': { name: 'Auckland Transport', currency: 'NZD' },
    'BIZ-002': { name: 'Sydney Client', currency: 'AUD' }
  };
  const html = cli.dashHours(entries, invoices, bizMap);
  const nums = Array.from(html.matchAll(/class="number">(?:<strong>)?([^<]+)/g))
    .map(function(m) { return m[1].trim(); });

  eq(html.indexOf('9,999') === -1, true, 'a voided invoice is not counted as invoiced');
  eq(html.indexOf('11.5') !== -1, true, 'hours total (got ' + nums.join(' | ') + ')');
  // Each currency's average rate must divide that currency's earnings by that
  // currency's hours: 1584.36 / 11.5 = 137.77, and 600 / 4 = 150.
  eq(/\$137\.77\/hr/.test(html), true, 'NZD average rate (got: ' +
    (/Avg rate:([^<]*)/.exec(html) || ['', ''])[1] + ')');
  eq(/150\.00\/hr/.test(html), true, 'AUD average rate');
  eq(html.indexOf('undefined') === -1 && html.indexOf('NaN') === -1, true, 'no undefined or NaN');
});

// =====================================================================
// 7. Date filtering cannot change what an invoice is worth
// =====================================================================

section('Filtering changes what is shown, never what anything is worth');

check('narrowing the range drops whole invoices, never parts of one', function() {
  buildBook();
  const narrow = { dateFrom: '2026-04-01', dateTo: '2026-06-30' };
  const shown = app.getBudgetSummary(narrow);

  const expected = r2(BOOK.filter(function(b) {
    return b.date >= narrow.dateFrom && b.date <= narrow.dateTo;
  }).reduce(function(s, b) { return s + b.time + (b.gst ? r2(b.time * 0.15) : 0); }, 0));

  exact(shown.totals.allocated, expected, 'the narrowed total is whole invoices only');
  exact(shown.totals.allocated, shown.totals.paid + shown.totals.outstanding,
    'and it still balances');
});

check('the full range is the sum of its parts', function() {
  buildBook();
  const h1 = app.getBudgetSummary({ dateFrom: '2026-01-01', dateTo: '2026-06-30' }).totals;
  const h2 = app.getBudgetSummary({ dateFrom: '2026-07-01', dateTo: '2026-12-31' }).totals;
  const all = app.getBudgetSummary(RANGE).totals;
  exact(h1.allocated + h2.allocated, all.allocated, 'two halves make the whole');
});

console.log('\n' + passes + ' passed, ' + failures + ' failed');
process.exit(failures > 0 ? 1 : 0);

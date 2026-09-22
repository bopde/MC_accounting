#!/usr/bin/env node
/**
 * The flows the other check scripts do not reach, against an in-memory
 * spreadsheet:
 *
 *   node tools/check-app-flows.js
 *
 *   1. getInvoiceDetails — the printed invoice's line items, where Hours x Rate
 *      must equal Amount even when a work code was billed at two rates.
 *   2. voidInvoice — unlinking in batches, and the order that makes a half-done
 *      void safe rather than double-billing.
 *   3. deallocateInvoice — the way out of "remove them first".
 *   4. getDashboardData — the budget tile must agree with getBudgetSummary,
 *      including after a part payment, and contract spend must not be counted
 *      twice where contracts overlap.
 *   5. The input guards added so bad data cannot be written silently.
 *
 * Google APIs are stubbed. This is not a substitute for running the app.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const FILES = ['BudgetCategories.gs', 'BudgetService.gs', 'SheetService.gs', 'Setup.gs',
  'IdService.gs', 'InvoiceService.gs', 'SettingsService.gs', 'ContractService.gs',
  'HoursService.gs', 'DashboardService.gs', 'AccountService.gs', 'ClientWrappers.gs'];

const source = FILES
  .map(function(f) { return fs.readFileSync(path.join(ROOT, 'src', 'server', f), 'utf8'); })
  .join('\n');

// --- In-memory spreadsheet ---

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
    // Counts every write, so a "batched" write can be shown to be batched.
    _writes: 0,
    deleteRow: function(rowIndex) { grid.splice(rowIndex - 1, 1); },
    getDataRange: function() {
      return sheet.getRange(1, 1, grid.length, sheet.getLastColumn());
    },
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
          sheet._writes++;
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

function makeSpreadsheet(sheets) {
  return {
    getSheets: function() { return Object.keys(sheets).map(function(k) { return sheets[k]; }); },
    getSheetByName: function(n) { return sheets[n] || null; },
    insertSheet: function(n) { sheets[n] = makeSheet(n, [], []); return sheets[n]; },
    deleteSheet: function(s) { delete sheets[s.getName()]; }
  };
}

const app = {
  Logger: { log: function() {} },
  LockService: { getScriptLock: function() { return { waitLock: function() {}, releaseLock: function() {} }; } },
  SpreadsheetApp: { getActiveSpreadsheet: function() { return app.__ss; } }
};
vm.createContext(app);
vm.runInContext(source, app, { filename: 'app-flows.js' });

/** A spreadsheet carrying every declared sheet, populated from plain objects. */
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
  app.__ss = makeSpreadsheet(sheets);
  return sheets;
}

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

function eq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error((msg ? msg + ': ' : '') + 'expected ' + JSON.stringify(expected) +
      ', got ' + JSON.stringify(actual));
  }
}

function near(actual, expected, msg) {
  if (Math.abs(Number(actual) - Number(expected)) > 0.005) {
    throw new Error((msg ? msg + ': ' : '') + 'expected ~' + expected + ', got ' + actual);
  }
}

function throws(fn, fragment) {
  let threw = null;
  try { fn(); } catch (e) { threw = e; }
  if (!threw) throw new Error('expected a throw, got none');
  if (fragment && threw.message.indexOf(fragment) === -1) {
    throw new Error('expected a message containing "' + fragment + '", got "' + threw.message + '"');
  }
}

function section(t) { console.log('\n' + t); }

const BUSINESS = {
  business_id: 'BIZ-001', name: 'Auckland Transport', currency: 'NZD',
  default_rate: 150, invoice_code: '', active: true
};

const RULE = {
  rule_id: 'BR-001', name: 'Company Default', model: 'company', is_default: true, active: true,
  biz_tax_withheld_pct: 0, biz_acc_withheld_pct: 0,
  biz_tax_pct: 0.28, biz_acc_pct: 0.01, biz_reserve_pct: 0.10,
  per_tax_pct: 0.30, per_acc_pct: 0.0167,
  per_donate_pct: 0.05, per_save_pct: 0.10, per_invest_pct: 0.15, per_spend_pct: 0.70
};

function entry(id, date, code, rate, hours) {
  return {
    entry_id: id, business_id: 'BIZ-001', date: date, time_start: '09:00', time_end: '10:00',
    hours: hours, description: code + ' work', work_code: code, rate: rate,
    line_total: Math.round(hours * rate * 100) / 100, invoice_id: '', contract_id: ''
  };
}

// --- 1. The printed invoice's line items ---

section('A work code billed at two rates prints two lines that add up');

check('one rate still prints as one line', function() {
  build({
    Businesses: [BUSINESS],
    WorkCodes: [{ code_id: 'DEV', description: 'Development', category: 'billable', active: true }],
    TimeEntries: [entry('TE-001', '2026-05-04', 'DEV', 150, 8), entry('TE-002', '2026-05-05', 'DEV', 150, 4)]
  });
  app.generateInvoice({ businessId: 'BIZ-001', dateFrom: '2026-05-01', dateTo: '2026-05-31',
    includeGst: true, gstRate: 0.15 });

  const details = app.getInvoiceDetails('AT0526');
  eq(details.codeGroups.length, 1, 'line count');
  eq(details.codeGroups[0].rate, 150, 'rate');
  eq(details.codeGroups[0].totalHours, 12, 'hours');
  eq(details.codeGroups[0].totalAmount, 1800, 'amount');
});

check('two rates split into two lines, each of which multiplies out', function() {
  build({
    Businesses: [BUSINESS],
    WorkCodes: [{ code_id: 'DEV', description: 'Development', category: 'billable', active: true }],
    TimeEntries: [
      entry('TE-001', '2026-05-04', 'DEV', 150, 8),
      entry('TE-002', '2026-05-20', 'DEV', 175, 4),
      entry('TE-003', '2026-05-21', 'DEV', 150, 2)
    ]
  });
  app.generateInvoice({ businessId: 'BIZ-001', dateFrom: '2026-05-01', dateTo: '2026-05-31',
    includeGst: false });

  const groups = app.getInvoiceDetails('AT0526').codeGroups;
  eq(groups.length, 2, 'line count');
  groups.forEach(function(g) {
    near(g.totalHours * g.rate, g.totalAmount,
      'line for ' + g.code + ' @ ' + g.rate + ' must multiply out');
  });
  eq(groups[0].rate, 150, 'cheaper rate first');
  eq(groups[1].rate, 175, 'then the higher one');
  near(groups[0].totalHours, 10, 'hours at the old rate');
  near(groups[1].totalHours, 4, 'hours at the new rate');
  near(groups[0].totalAmount + groups[1].totalAmount, 2200, 'the two lines still sum to the invoice');
});

check('two codes keep the order they were first billed in', function() {
  build({
    Businesses: [BUSINESS],
    WorkCodes: [
      { code_id: 'DEV', description: 'Development', category: 'billable', active: true },
      { code_id: 'ADV', description: 'Advisory', category: 'billable', active: true }
    ],
    TimeEntries: [
      entry('TE-001', '2026-05-04', 'ADV', 200, 2),
      entry('TE-002', '2026-05-05', 'DEV', 150, 8),
      entry('TE-003', '2026-05-06', 'ADV', 220, 1)
    ]
  });
  app.generateInvoice({ businessId: 'BIZ-001', dateFrom: '2026-05-01', dateTo: '2026-05-31',
    includeGst: false });

  const groups = app.getInvoiceDetails('AT0526').codeGroups;
  eq(groups.map(function(g) { return g.code + '@' + g.rate; }).join(','),
    'ADV@200,ADV@220,DEV@150', 'first-billed code first, then rate within it');
});

// --- 2. Voiding ---

section('Voiding frees the work without ever double-billing it');

function withInvoice(entryCount) {
  const entries = [];
  for (let i = 0; i < entryCount; i++) {
    // Deliberately non-contiguous work: two codes interleaved would still be
    // one run of rows, so the batching is exercised by the row span, not gaps.
    entries.push(entry('TE-' + (i + 1), '2026-05-' + String((i % 28) + 1).padStart(2, '0'), 'DEV', 150, 1));
  }
  const sheets = build({
    Businesses: [BUSINESS],
    WorkCodes: [{ code_id: 'DEV', description: 'Development', category: 'billable', active: true }],
    BudgetRules: [RULE],
    TimeEntries: entries,
    Expenses: [{ expense_id: 'EXP-001', business_id: 'BIZ-001', date: '2026-05-10',
      amount: 40, description: 'Parking', work_code: 'DEV', invoice_id: '' }]
  });
  app.generateInvoice({ businessId: 'BIZ-001', dateFrom: '2026-05-01', dateTo: '2026-05-31',
    includeGst: false });
  return sheets;
}

check('every entry is unlinked and can be billed again', function() {
  withInvoice(5);
  app.updateInvoiceStatus('AT0526', 'void');

  eq(app.getAll('Invoices')[0].status, 'void', 'invoice status');
  const stillLinked = app.getAll('TimeEntries').filter(function(te) { return te.invoice_id !== ''; });
  eq(stillLinked.length, 0, 'time entries still linked');
  eq(app.getAll('Expenses').filter(function(e) { return e.invoice_id !== ''; }).length, 0,
    'expenses still linked');

  const free = app.getUninvoicedItemsInternal('BIZ-001', '2026-05-01', '2026-05-31', '');
  eq(free.timeEntries.length, 5, 'entries offered for re-invoicing');
  eq(free.expenses.length, 1, 'expense offered for re-invoicing');
});

check('unlinking is batched, not one write per row', function() {
  const sheets = withInvoice(40);
  sheets.TimeEntries._writes = 0;
  app.updateInvoiceStatus('AT0526', 'void');
  // 40 contiguous rows is one range. One write per row was 40, and a real
  // invoice of 150 entries then ran past the client's timeout.
  eq(sheets.TimeEntries._writes <= 2, true,
    'writes to unlink 40 rows (got ' + sheets.TimeEntries._writes + ')');
});

check('the invoice is marked void before anything is unlinked', function() {
  const sheets = withInvoice(3);
  const statusCol = app.sheetSchemas().Invoices.indexOf('status');
  let statusWhenFirstUnlinked = null;

  const realSetValues = sheets.TimeEntries.getRange(1, 1).setValues;
  const originalGetRange = sheets.TimeEntries.getRange;
  sheets.TimeEntries.getRange = function(r, c, nr, nc) {
    const range = originalGetRange.call(sheets.TimeEntries, r, c, nr, nc);
    const wrapped = range.setValues;
    range.setValues = function(v) {
      if (statusWhenFirstUnlinked === null) {
        statusWhenFirstUnlinked = app.__ss.getSheetByName('Invoices')._grid[1][statusCol];
      }
      return wrapped.call(this, v);
    };
    return range;
  };

  app.updateInvoiceStatus('AT0526', 'void');
  sheets.TimeEntries.getRange = originalGetRange;
  void realSetValues;

  eq(statusWhenFirstUnlinked, 'void',
    'a run that dies mid-void must not leave loose entries on a live invoice');
});

check('voiding is refused while the invoice is allocated, and says how to proceed', function() {
  withInvoice(2);
  app.updateInvoiceStatus('AT0526', 'sent');
  app.updateInvoiceStatus('AT0526', 'paid');
  app.allocateBudget('AT0526', 'BR-001');
  throws(function() { app.updateInvoiceStatus('AT0526', 'void'); }, 'Remove allocation');
});

// --- 3. Removing an allocation ---

section('An allocation can be removed again');

check('removing it frees the invoice to be voided or re-allocated', function() {
  withInvoice(2);
  app.updateInvoiceStatus('AT0526', 'sent');
  app.updateInvoiceStatus('AT0526', 'paid');
  app.allocateBudget('AT0526', 'BR-001');
  eq(app.getAll('BudgetAllocations').length > 0, true, 'allocated to begin with');

  const result = app.deallocateInvoice('AT0526');
  eq(result.removed > 0, true, 'rows removed');
  eq(app.getAll('BudgetAllocations').length, 0, 'allocations left');
  eq(app.getAll('Invoices')[0].budget_rule_id, '', 'rule stamp cleared');

  // And the two things it unblocks both work now.
  app.allocateBudget('AT0526', 'BR-001');
  eq(app.getAll('BudgetAllocations').length > 0, true, 're-allocated');
  app.deallocateInvoice('AT0526');
  app.updateInvoiceStatus('AT0526', 'void');
  eq(app.getAll('Invoices')[0].status, 'void', 'voided');
});

check('refused while a payment has settled part of it, naming the payment', function() {
  withInvoice(2);
  app.updateInvoiceStatus('AT0526', 'sent');
  app.updateInvoiceStatus('AT0526', 'paid');
  app.allocateBudget('AT0526', 'BR-001');

  const range = { dateFrom: '2026-01-01', dateTo: '2026-12-31' };
  app.payBudgetCategories('biz_tax', 10, '2026-06-01', 'part', range);

  throws(function() { app.deallocateInvoice('AT0526'); }, 'payment');
  eq(app.getAll('BudgetAllocations').length > 0, true, 'nothing was removed');

  // Undo the payment and it goes through, which is what the message says to do.
  const payment = app.getBudgetSummary(range).payments[0];
  app.undoBudgetPayment(payment.payment_id);
  eq(app.deallocateInvoice('AT0526').removed > 0, true, 'removed after the undo');
});

check('an invoice with no allocations says so rather than reporting success', function() {
  withInvoice(1);
  throws(function() { app.deallocateInvoice('AT0526'); }, 'no budget allocations');
});

// --- 4. The Dashboard must agree with the Budget page ---

section('The Dashboard budget tile agrees with the Money Flow page');

function allocatedFixture() {
  withInvoice(10);
  app.updateInvoiceStatus('AT0526', 'sent');
  app.updateInvoiceStatus('AT0526', 'paid');
  app.allocateBudget('AT0526', 'BR-001');
}

const RANGE = { dateFrom: '2026-01-01', dateTo: '2026-12-31' };

function tileFor(key) {
  const dash = app.getDashboardData(RANGE);
  return (dash.budget || []).find(function(c) { return c.key === key; }) ||
    { allocated: 0, paid: 0, outstanding: 0 };
}

function bucketFor(key) {
  const sum = app.getBudgetSummary(RANGE);
  let found = null;
  (sum.scopes || []).forEach(function(g) {
    (g.categories || []).forEach(function(c) { if (c.key === key) found = c; });
  });
  return found || { allocated: 0, paid: 0, outstanding: 0 };
}

check('they agree before any payment', function() {
  allocatedFixture();
  near(tileFor('biz_tax').outstanding, bucketFor('biz_tax').outstanding, 'business tax outstanding');
  near(tileFor('biz_tax').paid, bucketFor('biz_tax').paid, 'business tax paid');
});

check('and after a PART payment, which is the case that used to diverge', function() {
  allocatedFixture();
  const owed = bucketFor('biz_tax').outstanding;
  app.payBudgetCategories('biz_tax', Math.round(owed / 2 * 100) / 100, '2026-06-01', '', RANGE);

  near(tileFor('biz_tax').paid, bucketFor('biz_tax').paid, 'paid');
  near(tileFor('biz_tax').outstanding, bucketFor('biz_tax').outstanding, 'outstanding');
  eq(tileFor('biz_tax').paid > 0, true, 'the payment actually registered');
  eq(tileFor('biz_tax').outstanding > 0, true, 'and it was only part of it');
});

check('a bucket paid in full reports a clean zero, not floating-point dust', function() {
  allocatedFixture();
  app.payBudgetCategories('per_acc', bucketFor('per_acc').outstanding, '2026-06-01', '', RANGE);
  eq(tileFor('per_acc').outstanding, 0, 'dashboard outstanding');
  eq(bucketFor('per_acc').outstanding, 0, 'budget page outstanding');
});

// --- 5. Contract attribution ---

section('Contract spend is attributed once, or not at all');

function contractFixture() {
  build({
    Businesses: [BUSINESS],
    WorkCodes: [{ code_id: 'DEV', description: 'Development', category: 'billable', active: true }],
    Contracts: [
      { contract_id: 'CON-001', business_id: 'BIZ-001', name: 'Phase 1', po_number: 'PO-1',
        date_from: '2026-01-01', date_to: '2026-06-30', value: 50000, currency: 'NZD',
        work_codes: '', status: 'active', notes: '' },
      { contract_id: 'CON-002', business_id: 'BIZ-001', name: 'Phase 2', po_number: 'PO-2',
        date_from: '2026-05-01', date_to: '2026-12-31', value: 50000, currency: 'NZD',
        work_codes: '', status: 'active', notes: '' }
    ],
    TimeEntries: [
      // Tagged: belongs to CON-001 whatever the dates say.
      Object.assign(entry('TE-001', '2026-05-10', 'DEV', 150, 10), { contract_id: 'CON-001' }),
      // Untagged, inside CON-001 only.
      entry('TE-002', '2026-02-10', 'DEV', 150, 4),
      // Untagged, inside CON-002 only.
      entry('TE-003', '2026-09-10', 'DEV', 150, 6),
      // Untagged, inside BOTH — nothing says which.
      entry('TE-004', '2026-05-15', 'DEV', 150, 8)
    ]
  });
}

check('a tagged entry goes to its own contract and nowhere else', function() {
  contractFixture();
  const progress = app.getContractProgress();
  const one = progress.find(function(c) { return c.contract_id === 'CON-001'; });
  // 10 tagged + 4 untagged-but-unambiguous hours. The 8 ambiguous hours are not
  // here, and the 6 hours inside CON-002 are not either.
  near(one.hours, 14, 'CON-001 hours');
  near(one.spent, 2100, 'CON-001 spend');
});

check('untagged time inside two overlapping contracts is counted against neither', function() {
  contractFixture();
  const progress = app.getContractProgress();
  const total = progress.reduce(function(s, c) { return s + c.hours; }, 0);
  // 10 + 4 + 6 = 20. Counting the ambiguous 8 towards both would give 36.
  near(total, 20, 'hours across all contracts');
});

check('and it is reported rather than silently missing', function() {
  contractFixture();
  const dash = app.getDashboardData({});
  near(dash.unattributedTime.hours, 8, 'unattributed hours');
  near(dash.unattributedTime.spent, 1200, 'unattributed spend');
  eq(dash.unattributedTime.entries, 1, 'unattributed entries');
});

check('the Dashboard and the Contracts tab report the same spend', function() {
  contractFixture();
  const dash = app.getDashboardData({});
  const tab = app.getContractProgress();
  tab.forEach(function(c) {
    const d = dash.contractProgress.find(function(x) { return x.contract_id === c.contract_id; });
    near(d.spent, c.spent, c.contract_id + ' spend');
    near(d.hours, c.hours, c.contract_id + ' hours');
    near(d.expected_pct, c.expected_pct, c.contract_id + ' expected pace');
  });
});

// --- 6. The balance a dashboard shows ---

section('The latest account balance is not hidden mid-month');

check('a summary for the month you are in shows up', function() {
  build({
    Accounts: [{ account_id: 'ACC-001', name: 'ASB Business', type: 'bank', currency: 'NZD',
      scope: 'business', purpose: 'operating', active: true }],
    AccountSummaries: [{ summary_id: 'AS-001', account_id: 'ACC-001', month: '2026-07',
      ending_balance: 12345, realised_gains: 0, unrealised_gains: 0, tax_paid: 0,
      total_in: 0, total_out: 0, notes: '' }]
  });
  const dash = app.getDashboardData({ dateFrom: '2026-07-01', dateTo: '2026-07-15' });
  eq(dash.accountBalances.length, 1, 'balances shown');
  eq(dash.accountBalances[0].balance, 12345, 'balance');
});

check('a summary for a later month is still excluded', function() {
  build({
    Accounts: [{ account_id: 'ACC-001', name: 'ASB Business', type: 'bank', currency: 'NZD',
      scope: 'business', purpose: 'operating', active: true }],
    AccountSummaries: [{ summary_id: 'AS-001', account_id: 'ACC-001', month: '2026-09',
      ending_balance: 999, realised_gains: 0, unrealised_gains: 0, tax_paid: 0,
      total_in: 0, total_out: 0, notes: '' }]
  });
  const dash = app.getDashboardData({ dateFrom: '2026-07-01', dateTo: '2026-07-15' });
  eq(dash.accountBalances.length, 0, 'balances shown');
});

// --- 7. Input guards ---

section('Bad input is refused rather than written');

check('an expense with an unparseable date is refused', function() {
  build({ Businesses: [BUSINESS],
    WorkCodes: [{ code_id: 'DEV', description: 'Dev', category: 'billable', active: true }] });
  throws(function() {
    app.addExpense({ business_id: 'BIZ-001', date: 'last tuesday', amount: 20, work_code: 'DEV' });
  }, 'not a valid date');
  eq(app.getAll('Expenses').length, 0, 'nothing was written');
});

check('a date that looks right but is not real is refused', function() {
  build({ Businesses: [BUSINESS],
    WorkCodes: [{ code_id: 'DEV', description: 'Dev', category: 'billable', active: true }] });
  throws(function() {
    app.addExpense({ business_id: 'BIZ-001', date: '2026-02-31', amount: 20, work_code: 'DEV' });
  }, 'not a real date');
});

check('a GST rate given as a percentage is refused, not billed 15x', function() {
  build({ Businesses: [BUSINESS],
    WorkCodes: [{ code_id: 'DEV', description: 'Dev', category: 'billable', active: true }],
    TimeEntries: [entry('TE-001', '2026-05-04', 'DEV', 150, 8)] });
  throws(function() {
    app.generateInvoice({ businessId: 'BIZ-001', dateFrom: '2026-05-01', dateTo: '2026-05-31',
      includeGst: true, gstRate: 15 });
  }, 'GST rate must be between');
  eq(app.getAll('Invoices').length, 0, 'no invoice was written');
});

check('a valid GST rate still works', function() {
  build({ Businesses: [BUSINESS],
    WorkCodes: [{ code_id: 'DEV', description: 'Dev', category: 'billable', active: true }],
    TimeEntries: [entry('TE-001', '2026-05-04', 'DEV', 150, 8)] });
  const inv = app.generateInvoice({ businessId: 'BIZ-001', dateFrom: '2026-05-01',
    dateTo: '2026-05-31', includeGst: true, gstRate: 0.15 });
  near(inv.gst_amount, 180, 'GST on $1,200');
});

check('a contract value that is not a number is refused on edit as well as add', function() {
  build({ Businesses: [BUSINESS] });
  throws(function() {
    app.addContract({ business_id: 'BIZ-001', name: 'X', date_from: '2026-01-01',
      date_to: '2026-06-30', value: '12,000' });
  }, 'positive number');

  app.addContract({ business_id: 'BIZ-001', name: 'X', date_from: '2026-01-01',
    date_to: '2026-06-30', value: 12000 });
  const id = app.getAll('Contracts')[0].contract_id;
  throws(function() { app.updateContract({ contract_id: id, value: '12,000' }); }, 'positive number');
  eq(Number(app.getAll('Contracts')[0].value), 12000, 'the stored value is untouched');
});

check('a contract that ends before it starts is refused', function() {
  build({ Businesses: [BUSINESS] });
  throws(function() {
    app.addContract({ business_id: 'BIZ-001', name: 'X', date_from: '2026-06-30',
      date_to: '2026-01-01', value: 100 });
  }, 'cannot be before');
});

check('editing one date is checked against the other, not in isolation', function() {
  build({ Businesses: [BUSINESS] });
  app.addContract({ business_id: 'BIZ-001', name: 'X', date_from: '2026-01-01',
    date_to: '2026-06-30', value: 100 });
  const id = app.getAll('Contracts')[0].contract_id;
  throws(function() { app.updateContract({ contract_id: id, date_from: '2026-12-01' }); },
    'cannot be before');
});

check('an id sent by the client cannot create a second row under it', function() {
  build({ Businesses: [BUSINESS] });
  app.addBusiness({ business_id: 'BIZ-001', name: 'Someone Else', currency: 'NZD' });
  const ids = app.getAll('Businesses').map(function(b) { return b.business_id; });
  eq(new Set(ids).size, ids.length, 'every business id is unique (' + ids.join(',') + ')');
});

console.log('\n' + passes + ' passed, ' + failures + ' failed');
process.exit(failures > 0 ? 1 : 0);

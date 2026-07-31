#!/usr/bin/env node
/**
 * Checks for the two mechanisms that stop a schema drift corrupting data:
 *
 *   node tools/check-sheet-guards.js
 *
 *   1. assertKnownColumns — a write whose field has no column must throw, not
 *      silently drop the value. This is the defect that lost a whole set of
 *      budget percentages and mislabelled allocations.
 *   2. migrateBudgetAllocations — repairs rows written while those columns were
 *      missing, classifying per INVOICE because six category labels are shared
 *      between the company and sole-trader models.
 *   3. checkSchema — reports missing columns so the app can warn up front.
 *
 * Google APIs are stubbed with an in-memory spreadsheet.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const FILES = ['BudgetCategories.gs', 'BudgetService.gs', 'SheetService.gs', 'Setup.gs',
  'IdService.gs', 'InvoiceService.gs', 'SettingsService.gs', 'ClientWrappers.gs'];

const source = FILES
  .map(function(f) { return fs.readFileSync(path.join(ROOT, 'src', 'server', f), 'utf8'); })
  .join('\n');

// --- In-memory spreadsheet ---

function makeSheet(name, headers, rows) {
  const grid = [headers.slice()].concat((rows || []).map(function(r) { return r.slice(); }));
  return {
    getName: function() { return name; },
    getLastRow: function() { return grid.length; },
    getLastColumn: function() { return grid.reduce(function(m, r) { return Math.max(m, r.length); }, 0); },
    setFrozenRows: function() { return this; },
    _grid: grid,
    getDataRange: function() {
      const width = grid.reduce(function(m, r) { return Math.max(m, r.length); }, 0);
      return this.getRange(1, 1, grid.length, width);
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
          values.forEach(function(line, r) {
            const target = row - 1 + r;
            while (grid.length <= target) grid.push([]);
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
}

function makeSpreadsheet(sheets) {
  return {
    getSheets: function() { return Object.keys(sheets).map(function(k) { return sheets[k]; }); },
    getSheetByName: function(n) { return sheets[n] || null; },
    insertSheet: function(n) {
      sheets[n] = makeSheet(n, [], []);
      return sheets[n];
    },
    deleteSheet: function(s) { delete sheets[s.getName()]; }
  };
}

const app = {
  Logger: { log: function() {} },
  LockService: { getScriptLock: function() { return { waitLock: function() {}, releaseLock: function() {} }; } },
  SpreadsheetApp: { getActiveSpreadsheet: function() { return app.__ss; } }
};
vm.createContext(app);
vm.runInContext(source, app, { filename: 'sheet-guards.js' });

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
    throw new Error((msg ? msg + ': ' : '') + 'expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
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

function section(t) { console.log('\n' + t); }

// --- assertKnownColumns ---

section('Unknown columns fail loudly instead of dropping data');

check('appendRow throws naming every missing column', function() {
  // The pre-update BudgetRules header row: no model, no biz_/per_ columns.
  app.__ss = makeSpreadsheet({
    BudgetRules: makeSheet('BudgetRules', [
      'rule_id', 'name', 'tax_withheld_pct', 'tax_to_pay_pct', 'acc_withheld_pct',
      'acc_to_pay_pct', 'donate_pct', 'save_pct', 'invest_pct', 'spend_pct',
      'is_default', 'notes'
    ], [])
  });

  throws(function() {
    app.appendRow('BudgetRules', {
      name: 'Company Default', model: 'company',
      biz_tax_pct: 0.28, per_tax_pct: 0.30, is_default: true
    });
  }, 'has no column(s)');

  // The message must name the columns and say what to do.
  let msg = '';
  try {
    app.appendRow('BudgetRules', { name: 'X', model: 'company', biz_tax_pct: 0.28 });
  } catch (e) { msg = e.message; }
  eq(msg.indexOf('model') !== -1, true, 'names model');
  eq(msg.indexOf('biz_tax_pct') !== -1, true, 'names biz_tax_pct');
  eq(msg.indexOf('setupSheets') !== -1, true, 'says how to fix it');
});

check('appendRow succeeds once the columns exist', function() {
  app.__ss = makeSpreadsheet({
    BudgetRules: makeSheet('BudgetRules', ['rule_id', 'name', 'model', 'biz_tax_pct'], [])
  });
  const written = app.appendRow('BudgetRules', { name: 'OK', model: 'company', biz_tax_pct: 0.28 });
  eq(written.rule_id, 'BR-001', 'generated id');
  const grid = app.__ss.getSheetByName('BudgetRules')._grid;
  eq(grid[1].join('|'), 'BR-001|OK|company|0.28', 'row contents');
});

check('_rowIndex is not treated as a column', function() {
  app.__ss = makeSpreadsheet({
    Accounts: makeSheet('Accounts', ['account_id', 'name', 'scope'], [['ACC-001', 'ASB', 'business']])
  });
  const row = app.getAll('Accounts')[0];
  eq(row._rowIndex, 2, 'row index attached');
  row.scope = 'personal';
  app.updateRow('Accounts', row._rowIndex, row);
  eq(app.__ss.getSheetByName('Accounts')._grid[1].join('|'), 'ACC-001|ASB|personal', 'updated');
});

check('updateRow throws on an unknown key too', function() {
  app.__ss = makeSpreadsheet({
    Accounts: makeSheet('Accounts', ['account_id', 'name'], [['ACC-001', 'ASB']])
  });
  throws(function() {
    app.updateRow('Accounts', 2, { account_id: 'ACC-001', name: 'ASB', scope: 'business' });
  }, 'scope');
});

// --- checkSchema ---

section('checkSchema reports what is missing');

check('reports only the genuinely missing columns', function() {
  app.__ss = makeSpreadsheet({
    Accounts: makeSheet('Accounts', ['account_id', 'name', 'type', 'currency', 'purpose', 'active'], [])
  });
  const warnings = app.checkSchema();
  const accounts = warnings.find(function(w) { return w.sheet === 'Accounts'; });
  eq(!!accounts, true, 'Accounts flagged');
  eq(accounts.missing.join(','), 'scope', 'only scope missing');
});

check('an up-to-date sheet is not flagged', function() {
  const schemas = app.sheetSchemas();
  const sheets = {};
  Object.keys(schemas).forEach(function(name) {
    sheets[name] = makeSheet(name, schemas[name], []);
  });
  app.__ss = makeSpreadsheet(sheets);
  eq(app.checkSchema().length, 0, 'no warnings');
});

// --- migrateBudgetAllocations ---

const ALLOC_HEADERS = ['allocation_id', 'invoice_id', 'category', 'category_key', 'scope',
  'percentage', 'amount', 'status', 'transfer_date', 'notes'];

function allocRow(id, invoice, category, amount) {
  return [id, invoice, category, '', '', '', amount, 'allocated', '', ''];
}

function withAllocations(rows) {
  app.__ss = makeSpreadsheet({ BudgetAllocations: makeSheet('BudgetAllocations', ALLOC_HEADERS, rows) });
  return app.__ss.getSheetByName('BudgetAllocations');
}

function keyed(sheet) {
  const map = {};
  sheet._grid.slice(1).forEach(function(r) { map[r[0]] = { key: r[3], scope: r[4] }; });
  return map;
}

section('Allocation repair classifies per invoice, not per row');

check('a company set is repaired to company keys', function() {
  // 'Spend' alone is ambiguous, but 'Business Tax' in the same invoice is not.
  const sheet = withAllocations([
    allocRow('BA-001', '0526', 'GST', 750),
    allocRow('BA-002', '0526', 'Business Tax', 1400),
    allocRow('BA-003', '0526', 'Reserve', 500),
    allocRow('BA-004', '0526', 'Owner Pay', 3050),
    allocRow('BA-005', '0526', 'Spend', 1458.85),
    allocRow('BA-006', '0526', 'Donate', 104.20)
  ]);
  const stamped = app.migrateBudgetAllocations();
  eq(stamped, 6, 'rows stamped');

  const got = keyed(sheet);
  eq(got['BA-002'].key, 'biz_tax', 'Business Tax');
  eq(got['BA-002'].scope, 'business', 'Business Tax scope');
  eq(got['BA-004'].key, 'owner_pay', 'Owner Pay');
  eq(got['BA-004'].scope, 'bridge', 'Owner Pay scope');
  // The whole point: a company Spend must NOT become legacy_spend.
  eq(got['BA-005'].key, 'per_spend', 'Spend');
  eq(got['BA-005'].scope, 'personal', 'Spend scope');
  eq(got['BA-006'].key, 'per_donate', 'Donate');
});

check('a genuine sole-trader set still maps to legacy keys', function() {
  const sheet = withAllocations([
    allocRow('BA-001', '0425', 'Tax To Pay', 246.40),
    allocRow('BA-002', '0425', 'ACC To Pay', 17.60),
    allocRow('BA-003', '0425', 'Spend', 431.20),
    allocRow('BA-004', '0425', 'Save', 61.60)
  ]);
  eq(app.migrateBudgetAllocations(), 4, 'rows stamped');

  const got = keyed(sheet);
  eq(got['BA-001'].key, 'legacy_tax', 'Tax To Pay');
  eq(got['BA-003'].key, 'legacy_spend', 'Spend');
  eq(got['BA-003'].scope, 'legacy', 'Spend scope');
});

check('the two kinds coexist without contaminating each other', function() {
  const sheet = withAllocations([
    allocRow('BA-001', '0425', 'Spend', 431.20),
    allocRow('BA-002', '0425', 'Tax To Pay', 246.40),
    allocRow('BA-003', '0526', 'Spend', 1458.85),
    allocRow('BA-004', '0526', 'Business Tax', 1400)
  ]);
  app.migrateBudgetAllocations();

  const got = keyed(sheet);
  eq(got['BA-001'].key, 'legacy_spend', 'old Spend stays legacy');
  eq(got['BA-003'].key, 'per_spend', 'new Spend becomes personal');
});

check('leading-zero invoice ids group together', function() {
  // Sheets stores '0526' on one row as the number 526; both belong to one invoice.
  const sheet = withAllocations([
    allocRow('BA-001', 526, 'Business Tax', 1400),
    allocRow('BA-002', '0526', 'Spend', 1458.85)
  ]);
  app.migrateBudgetAllocations();
  eq(keyed(sheet)['BA-002'].key, 'per_spend', 'grouped by normalised id');
});

check('already-stamped rows are left alone and re-running changes nothing', function() {
  const rows = [
    allocRow('BA-001', '0526', 'Business Tax', 1400),
    allocRow('BA-002', '0526', 'Spend', 1458.85)
  ];
  rows[1][3] = 'legacy_spend';
  rows[1][4] = 'legacy';
  const sheet = withAllocations(rows);

  eq(app.migrateBudgetAllocations(), 1, 'only the blank row stamped');
  eq(keyed(sheet)['BA-002'].key, 'legacy_spend', 'existing key preserved');

  const before = JSON.stringify(sheet._grid);
  eq(app.migrateBudgetAllocations(), 0, 'second run stamps nothing');
  eq(JSON.stringify(sheet._grid), before, 'grid unchanged');
});

check('amounts and statuses are never touched', function() {
  const sheet = withAllocations([allocRow('BA-001', '0526', 'Business Tax', 1400)]);
  sheet._grid[1][7] = 'paid';
  app.migrateBudgetAllocations();
  eq(sheet._grid[1][6], 1400, 'amount');
  eq(sheet._grid[1][7], 'paid', 'status');
  eq(sheet._grid[1][2], 'Business Tax', 'label');
});

check('an unrecognised label is left blank rather than guessed', function() {
  const sheet = withAllocations([allocRow('BA-001', '0526', 'Something Else', 10)]);
  eq(app.migrateBudgetAllocations(), 0, 'nothing stamped');
  eq(keyed(sheet)['BA-001'].key, '', 'left blank');
});

check('missing columns are reported, not written to', function() {
  app.__ss = makeSpreadsheet({
    BudgetAllocations: makeSheet('BudgetAllocations',
      ['allocation_id', 'invoice_id', 'category', 'amount'], [['BA-001', '0526', 'Spend', 10]])
  });
  eq(app.migrateBudgetAllocations(), 0, 'no-op without the columns');
});

// --- invoice_code on an unmigrated Businesses sheet ---

section('Adding a business before the invoice_code column exists');

const OLD_BIZ_HEADERS = ['business_id', 'name', 'contact_name', 'email', 'address',
  'default_rate', 'currency', 'active'];
const NEW_BIZ_HEADERS = ['business_id', 'name', 'contact_name', 'email', 'address',
  'default_rate', 'currency', 'invoice_code', 'active'];

function withBusinesses(headers, rows) {
  app.__ss = makeSpreadsheet({ Businesses: makeSheet('Businesses', headers, rows || []) });
  return app.__ss.getSheetByName('Businesses');
}

check('a business with no code still saves on the old sheet', function() {
  const sheet = withBusinesses(OLD_BIZ_HEADERS);
  app.addBusiness({ name: 'Auckland Transport', currency: 'NZD', invoice_code: '' });
  eq(sheet._grid[1][1], 'Auckland Transport', 'name written');
  // The prefix is derived from the name, so nothing is lost by omitting it.
  eq(app.businessInvoicePrefix({ name: 'Auckland Transport' }), 'AT', 'prefix still derivable');
});

check('a code the user typed fails loudly rather than vanishing', function() {
  withBusinesses(OLD_BIZ_HEADERS);
  throws(function() {
    app.addBusiness({ name: 'Air Traffic', currency: 'NZD', invoice_code: 'ATC' });
  }, 'invoice_code');
  let msg = '';
  try {
    app.addBusiness({ name: 'Air Traffic 2', currency: 'NZD', invoice_code: 'ATC' });
  } catch (e) { msg = e.message; }
  eq(msg.indexOf('setupSheets') !== -1, true, 'message says how to fix it');
});

check('a code saves once the column exists', function() {
  const sheet = withBusinesses(NEW_BIZ_HEADERS);
  app.addBusiness({ name: 'Air Traffic', currency: 'NZD', invoice_code: 'atc' });
  eq(sheet._grid[1][7], 'ATC', 'stored upper-cased');
});

check('clearing a code on the old sheet does not trip the guard', function() {
  withBusinesses(OLD_BIZ_HEADERS, [['BIZ-001', 'Acme', '', '', '', 0, 'NZD', true]]);
  app.updateBusiness({ business_id: 'BIZ-001', name: 'Acme', invoice_code: '' });
  eq(app.getAll('Businesses')[0].name, 'Acme', 'update went through');
});

check('clearing a code on the new sheet actually clears it', function() {
  const sheet = withBusinesses(NEW_BIZ_HEADERS,
    [['BIZ-001', 'Acme', '', '', '', 0, 'NZD', 'XYZ', true]]);
  app.updateBusiness({ business_id: 'BIZ-001', name: 'Acme', invoice_code: '' });
  eq(sheet._grid[1][7], '', 'code cleared');
  eq(app.businessInvoicePrefix(app.getAll('Businesses')[0]), 'AC', 'falls back to the name');
});

check('getAllBusinesses annotates the resolved prefix', function() {
  withBusinesses(NEW_BIZ_HEADERS, [
    ['BIZ-001', 'Auckland Transport', '', '', '', 0, 'NZD', '', true],
    ['BIZ-002', 'Air Traffic', '', '', '', 0, 'NZD', 'ATC', true]
  ]);
  const rows = app.getAllBusinesses();
  eq(rows[0].invoice_prefix, 'AT', 'derived');
  eq(rows[0].invoice_prefix_auto, 'AT', 'auto matches when there is no override');
  eq(rows[1].invoice_prefix, 'ATC', 'override wins');
  eq(rows[1].invoice_prefix_auto, 'AT', 'auto shows what clearing it would give');
});

section('Prefix collisions are refused at save time');

check('a second business deriving the same prefix is rejected', function() {
  withBusinesses(NEW_BIZ_HEADERS,
    [['BIZ-001', 'Auckland Transport', '', '', '', 0, 'NZD', '', true]]);
  // "Alpha Technologies" also derives AT; sharing a prefix means sharing one
  // suffix sequence, so each client's numbering would come out with holes.
  throws(function() {
    app.addBusiness({ name: 'Alpha Technologies', currency: 'NZD' });
  }, 'already used by');
});

check('the message names the clashing client and the fix', function() {
  withBusinesses(NEW_BIZ_HEADERS,
    [['BIZ-001', 'Auckland Transport', '', '', '', 0, 'NZD', '', true]]);
  let msg = '';
  try { app.addBusiness({ name: 'Alpha Technologies', currency: 'NZD' }); } catch (e) { msg = e.message; }
  eq(msg.indexOf('Auckland Transport') !== -1, true, 'names the clash');
  eq(msg.indexOf('Invoice Code') !== -1, true, 'says what to do');
});

check('an explicit code resolves the clash', function() {
  const sheet = withBusinesses(NEW_BIZ_HEADERS,
    [['BIZ-001', 'Auckland Transport', '', '', '', 0, 'NZD', '', true]]);
  app.addBusiness({ name: 'Alpha Technologies', currency: 'NZD', invoice_code: 'ALT' });
  eq(sheet._grid[2][7], 'ALT', 'stored');
});

check('renaming into a clash is refused too', function() {
  withBusinesses(NEW_BIZ_HEADERS, [
    ['BIZ-001', 'Auckland Transport', '', '', '', 0, 'NZD', '', true],
    ['BIZ-002', 'Beta Corp', '', '', '', 0, 'NZD', '', true]
  ]);
  throws(function() {
    app.updateBusiness({ business_id: 'BIZ-002', name: 'Alpha Technologies' });
  }, 'already used by');
});

check('a business can be saved without clashing with itself', function() {
  withBusinesses(NEW_BIZ_HEADERS,
    [['BIZ-001', 'Auckland Transport', '', '', '', 0, 'NZD', '', true]]);
  app.updateBusiness({ business_id: 'BIZ-001', name: 'Auckland Transport', email: 'a@b.c' });
  eq(app.getAll('Businesses')[0].email, 'a@b.c', 'saved');
});

check('an unusable code is refused rather than silently ignored', function() {
  withBusinesses(NEW_BIZ_HEADERS);
  // '007' normalises to '' (leading digits dropped), which would silently give
  // the name-derived prefix instead of what the user asked for.
  throws(function() {
    app.addBusiness({ name: 'Bond Security', currency: 'NZD', invoice_code: '007' });
  }, 'must contain a letter');
});

section('Toggling is addressed by id, not a snapshot row index');

check('deactivating hits the named record even after rows shift', function() {
  const sheet = withBusinesses(NEW_BIZ_HEADERS, [
    ['BIZ-001', 'Acme', '', '', '', 0, 'NZD', '', true],
    ['BIZ-002', 'Beta', '', '', '', 0, 'NZD', '', true]
  ]);
  // Simulate a row being removed in the Sheets UI after the table was rendered:
  // BIZ-002 moves from row 3 to row 2. Addressing by row index would hit the
  // wrong record; addressing by id cannot.
  sheet._grid.splice(1, 1);
  app.toggleEntityFromClient('Businesses|BIZ-002|false');
  const rows = app.getAll('Businesses');
  eq(rows.length, 1, 'one row left');
  eq(rows[0].business_id, 'BIZ-002', 'the surviving row');
  eq(rows[0].active, false, 'and it is the one deactivated');
});

check('an unknown id is refused rather than writing blind', function() {
  withBusinesses(NEW_BIZ_HEADERS, [['BIZ-001', 'Acme', '', '', '', 0, 'NZD', '', true]]);
  throws(function() { app.toggleEntityFromClient('Businesses|BIZ-999|false'); }, 'Not found');
});

check('a sheet outside the allowlist is refused', function() {
  withBusinesses(NEW_BIZ_HEADERS);
  throws(function() { app.toggleEntityFromClient('Invoices|0526|false'); }, 'Access denied');
});

check('a missing id is refused', function() {
  withBusinesses(NEW_BIZ_HEADERS);
  throws(function() { app.toggleEntityFromClient('Businesses||false'); }, 'Missing entity id');
});

console.log('\n' + passes + ' passed, ' + failures + ' failed');
process.exit(failures > 0 ? 1 : 0);

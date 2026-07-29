/**
 * One-time setup: creates all required sheets with headers.
 * Run this function once after creating a new Google Spreadsheet.
 *
 * This script is designed to be CONTAINER-BOUND: create it from within
 * your spreadsheet via Extensions > Apps Script. This way it only needs
 * permission to access that one spreadsheet (spreadsheets.currentonly),
 * not all your spreadsheets.
 */

function getSpreadsheet() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

/**
 * Creates all sheets with headers. Safe to run multiple times -
 * skips sheets that already exist.
 */
function setupSheets() {
  var ss = getSpreadsheet();

  var schemas = {
    'Businesses': [
      'business_id', 'name', 'contact_name', 'email', 'address',
      'default_rate', 'currency', 'active'
    ],
    'WorkCodes': [
      'code_id', 'description', 'category', 'contract_id', 'active'
    ],
    'Accounts': [
      'account_id', 'name', 'type', 'currency', 'scope', 'purpose', 'active'
    ],
    // Legacy sole-trader percentage columns are retained so historical rules
    // keep working; company rules use the biz_/per_ columns.
    'BudgetRules': [
      'rule_id', 'name', 'model',
      'tax_withheld_pct', 'tax_to_pay_pct',
      'acc_withheld_pct', 'acc_to_pay_pct',
      'donate_pct', 'save_pct', 'invest_pct', 'spend_pct',
      'biz_tax_withheld_pct', 'biz_acc_withheld_pct',
      'biz_tax_pct', 'biz_acc_pct', 'biz_reserve_pct',
      'per_tax_pct', 'per_acc_pct',
      'per_donate_pct', 'per_save_pct', 'per_invest_pct', 'per_spend_pct',
      'is_default', 'notes', 'active'
    ],
    'MyDetails': [
      'key', 'value'
    ],
    'Contracts': [
      'contract_id', 'business_id', 'name', 'po_number',
      'date_from', 'date_to', 'value', 'currency',
      'work_codes', 'status', 'notes'
    ],
    'TimeEntries': [
      'entry_id', 'business_id', 'date', 'time_start', 'time_end',
      'hours', 'description', 'work_code', 'rate', 'line_total',
      'invoice_id', 'contract_id'
    ],
    'Expenses': [
      'expense_id', 'business_id', 'date', 'amount', 'description',
      'work_code', 'invoice_id'
    ],
    'Invoices': [
      'invoice_id', 'business_id', 'date_from', 'date_to', 'created_date',
      'include_gst', 'gst_rate', 'time_subtotal', 'subtotal', 'gst_amount', 'total',
      'status', 'budget_rule_id', 'contract_id', 'po_number',
      'description', 'notes', 'line_descriptions'
    ],
    'BudgetAllocations': [
      'allocation_id', 'invoice_id', 'category', 'category_key', 'scope',
      'percentage', 'amount', 'status', 'transfer_date', 'notes'
    ],
    'AccountSummaries': [
      'summary_id', 'account_id', 'month', 'ending_balance',
      'realised_gains', 'unrealised_gains', 'tax_paid',
      'total_in', 'total_out', 'notes'
    ]
  };

  var existingSheets = ss.getSheets().map(function(s) { return s.getName(); });

  Object.keys(schemas).forEach(function(sheetName) {
    if (existingSheets.indexOf(sheetName) === -1) {
      var sheet = ss.insertSheet(sheetName);
      sheet.getRange(1, 1, 1, schemas[sheetName].length).setValues([schemas[sheetName]]);
      sheet.getRange(1, 1, 1, schemas[sheetName].length)
        .setFontWeight('bold')
        .setBackground('#4a86c8')
        .setFontColor('#ffffff');
      sheet.setFrozenRows(1);
      Logger.log('Created sheet: ' + sheetName);
    } else {
      Logger.log('Sheet already exists: ' + sheetName);
    }
  });

  // Populate MyDetails with default keys if empty
  var detailsSheet = ss.getSheetByName('MyDetails');
  if (detailsSheet && detailsSheet.getLastRow() <= 1) {
    var defaultDetails = [
      ['business_name', ''],
      ['contact_name', ''],
      ['email', ''],
      ['phone', ''],
      ['address', ''],
      ['tax_number', ''],
      ['gst_number', ''],
      ['bank_account', ''],
      ['payment_terms', 'Due within 14 days']
    ];
    detailsSheet.getRange(2, 1, defaultDetails.length, 2).setValues(defaultDetails);
  }

  // Remove default "Sheet1" if it exists and is empty
  var sheet1 = ss.getSheetByName('Sheet1');
  if (sheet1 && sheet1.getLastRow() === 0) {
    ss.deleteSheet(sheet1);
  }

  // Add missing columns to existing sheets
  migrateColumns(ss, schemas);

  // Backfill identity columns on pre-company allocations, then make sure a
  // company rule exists so the Allocate tab is usable straight away.
  migrateBudgetAllocations();
  seedCompanyBudgetRule();

  Logger.log('Setup complete!');
  return 'Setup complete! Created sheets: ' + Object.keys(schemas).join(', ');
}

/**
 * Stamp category_key and scope onto BudgetAllocations rows written before the
 * business/personal split. Idempotent: rows that already carry a category_key
 * are left alone, and nothing is written when there is nothing to stamp.
 *
 * Amounts, labels and statuses are never touched — only the two new identity
 * columns are filled, so historical figures stay exactly as they were.
 */
function migrateBudgetAllocations() {
  var ss = getSpreadsheet();
  var sheet = ss.getSheetByName('BudgetAllocations');
  if (!sheet) return 0;

  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return 0;

  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var catCol = headers.indexOf('category');
  var keyCol = headers.indexOf('category_key');
  var scopeCol = headers.indexOf('scope');
  if (catCol === -1 || keyCol === -1 || scopeCol === -1) {
    Logger.log('migrateBudgetAllocations: columns missing, run setupSheets first');
    return 0;
  }

  var values = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  var keys = [];
  var scopes = [];
  var stamped = 0;

  values.forEach(function(row) {
    var existing = row[keyCol];
    if (existing !== '' && existing !== null && existing !== undefined) {
      keys.push([existing]);
      scopes.push([row[scopeCol]]);
      return;
    }
    var key = LEGACY_LABEL_TO_KEY[String(row[catCol])] || '';
    keys.push([key]);
    scopes.push([key ? 'legacy' : row[scopeCol]]);
    if (key) stamped++;
  });

  if (stamped > 0) {
    sheet.getRange(2, keyCol + 1, keys.length, 1).setValues(keys);
    sheet.getRange(2, scopeCol + 1, scopes.length, 1).setValues(scopes);
  }

  Logger.log('migrateBudgetAllocations: stamped ' + stamped + ' legacy row(s)');
  return stamped;
}

/**
 * Create a "Company Default" budget rule from the registry defaults if no
 * company rule exists yet. The percentages are placeholders reflecting current
 * NZ rates — review them before relying on the numbers.
 */
function seedCompanyBudgetRule() {
  var rules;
  try {
    rules = getAll('BudgetRules');
  } catch (e) {
    return null;
  }

  var hasCompanyRule = rules.some(function(r) { return ruleModel(r) === MODEL_COMPANY; });
  if (hasCompanyRule) {
    Logger.log('seedCompanyBudgetRule: company rule already exists, skipping');
    return null;
  }

  var data = {
    name: 'Company Default',
    model: MODEL_COMPANY,
    is_default: true,
    notes: 'Seeded defaults — review every percentage before relying on it.'
  };
  BUDGET_CATEGORY_DEFS.forEach(function(def) {
    if (!def.pctField) return;
    data[def.pctField] = def.defaultPct == null ? 0 : def.defaultPct;
  });

  var created = addBudgetRule(data);
  Logger.log('seedCompanyBudgetRule: created ' + created.rule_id);
  return created;
}

/**
 * Add any missing columns to existing sheets.
 * Safe to run repeatedly — only appends columns that don't exist yet.
 */
function migrateColumns(ss, schemas) {
  Object.keys(schemas).forEach(function(sheetName) {
    var sheet = ss.getSheetByName(sheetName);
    if (!sheet) return;
    var lastCol = sheet.getLastColumn();
    var existing = lastCol > 0
      ? sheet.getRange(1, 1, 1, lastCol).getValues()[0]
      : [];
    var added = [];
    schemas[sheetName].forEach(function(col) {
      if (existing.indexOf(col) === -1) {
        var newCol = existing.length + added.length + 1;
        sheet.getRange(1, newCol).setValue(col)
          .setFontWeight('bold')
          .setBackground('#4a86c8')
          .setFontColor('#ffffff');
        added.push(col);
      }
    });
    if (added.length > 0) {
      Logger.log('Added columns to ' + sheetName + ': ' + added.join(', '));
    }
  });
}

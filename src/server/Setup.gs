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
      'account_id', 'name', 'type', 'currency', 'purpose', 'active'
    ],
    'BudgetRules': [
      'rule_id', 'name',
      'tax_withheld_pct', 'tax_to_pay_pct',
      'acc_withheld_pct', 'acc_to_pay_pct',
      'donate_pct', 'save_pct', 'invest_pct', 'spend_pct',
      'is_default', 'notes'
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
      'allocation_id', 'invoice_id', 'category', 'percentage',
      'amount', 'status', 'transfer_date', 'notes'
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

  Logger.log('Setup complete!');
  return 'Setup complete! Created sheets: ' + Object.keys(schemas).join(', ');
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

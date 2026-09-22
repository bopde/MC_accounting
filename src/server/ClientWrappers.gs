/**
 * Wrapper functions for client-side calls.
 *
 * google.script.run can only pass a single argument per call.
 * These wrappers accept pipe-delimited strings or single objects
 * and forward to the actual service functions.
 */

/**
 * Update invoice status from client.
 * @param {string} params - "invoiceId|newStatus"
 */
function updateInvoiceStatusFromClient(params) {
  var parts = String(params).split('|');
  if (parts.length < 2) throw new Error('Invalid parameters');
  return updateInvoiceStatus(parts[0], parts[1]);
}

/**
 * Allocate budget from client.
 * @param {string} params - "invoiceId|ruleId"
 */
function allocateBudgetFromClient(params) {
  var parts = String(params).split('|');
  if (parts.length < 2) throw new Error('Invalid parameters');
  return allocateBudget(parts[0], parts[1]);
}

/**
 * Update allocation status from client.
 * @param {string} params - "allocationId|newStatus|transferDate"
 */
function updateAllocationStatusFromClient(params) {
  var parts = String(params).split('|');
  if (parts.length < 2) throw new Error('Invalid parameters');
  return updateAllocationStatus(parts[0], parts[1], parts[2] || null, parts[3] || null);
}

/**
 * Toggle active status of a reference entity (Business, WorkCode, Account).
 * @param {string} params - "sheetName|rowIndex|active"
 */
function toggleEntityFromClient(params) {
  var ALLOWED = ['Businesses', 'WorkCodes', 'Accounts', 'BudgetRules'];
  var parts = params.split('|');
  var sheetName = parts[0];
  var rowIndex = parseInt(parts[1], 10);
  var active = parts[2] === 'true';

  if (ALLOWED.indexOf(sheetName) === -1) {
    throw new Error('Access denied: cannot toggle ' + sheetName);
  }

  if (isNaN(rowIndex) || rowIndex < 2) {
    throw new Error('Invalid row index');
  }

  var ss = getSpreadsheet();
  var sheet = ss.getSheetByName(sheetName);
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var row = sheet.getRange(rowIndex, 1, 1, headers.length).getValues()[0];

  // Find the 'active' column
  var activeCol = headers.indexOf('active');
  if (activeCol === -1) throw new Error('No active column in ' + sheetName);

  row[activeCol] = active;
  sheet.getRange(rowIndex, 1, 1, row.length).setValues([row]);
  return { success: true };
}

/**
 * Get uninvoiced items — delegates to the canonical implementation
 * in InvoiceService. This wrapper exists because google.script.run
 * can only pass a single argument (the params object).
 */
function getUninvoicedItems(params) {
  return getUninvoicedItemsInternal(params.businessId, params.dateFrom, params.dateTo, params.contractId);
}

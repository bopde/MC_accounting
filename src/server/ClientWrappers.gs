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
 * Preview an allocation from client. Returns what allocateBudget would write.
 * @param {string} params - "invoiceId|ruleId"
 */
function previewAllocationFromClient(params) {
  var parts = String(params).split('|');
  if (parts.length < 2) throw new Error('Invalid parameters');
  return previewAllocation(parts[0], parts[1]);
}

/**
 * Update allocation status from client.
 * @param {string} params - "allocationId|newStatus|transferDate|notes"
 */
function updateAllocationStatusFromClient(params) {
  var parts = String(params).split('|');
  if (parts.length < 2) throw new Error('Invalid parameters');
  // The note is free text and may itself contain '|' (e.g. "ASB 4471 | GST Q2"),
  // so it takes everything after the third delimiter rather than one field.
  var notes = parts.length > 3 ? parts.slice(3).join('|') : '';
  return updateAllocationStatus(parts[0], parts[1], parts[2] || null, notes || null);
}

/**
 * Record a payment against one or more budget categories.
 *
 * @param {string} params - "categoryKeys|amount|paymentDate|dateFrom|dateTo|notes"
 *
 * The note comes last and takes everything after the fifth delimiter, because
 * free text may itself contain '|' (e.g. "ASB 4471 | GST Q2").
 */
function payBudgetCategoriesFromClient(params) {
  var parts = String(params).split('|');
  if (parts.length < 3) throw new Error('Invalid parameters');
  var notes = parts.length > 5 ? parts.slice(5).join('|') : '';
  return payBudgetCategories(parts[0], parts[1], parts[2] || null, notes || null, {
    dateFrom: parts[3] || '',
    dateTo: parts[4] || ''
  });
}

/**
 * Undo a recorded payment, putting back what it took from each allocation.
 * @param {string} paymentId
 */
function undoBudgetPaymentFromClient(paymentId) {
  return undoBudgetPayment(String(paymentId));
}

/**
 * Toggle active status of a reference entity (Business, WorkCode, Account).
 * @param {string} params - "sheetName|rowIndex|active"
 */
/**
 * Activate or deactivate a reference entity, addressed by its ID.
 *
 * @param {string} params - "sheetName|entityId|active"
 *
 * Addressed by ID, not by row index: the row index the client renders with is a
 * snapshot, so inserting or deleting a row in the spreadsheet afterwards made
 * Deactivate silently hit whichever record had moved into that position. The row
 * is re-resolved here, under the lock, every time.
 */
function toggleEntityFromClient(params) {
  var ALLOWED = ['Businesses', 'WorkCodes', 'Accounts', 'BudgetRules'];
  var parts = String(params).split('|');
  var sheetName = parts[0];
  var entityId = parts[1];
  var active = parts[2] === 'true';

  if (ALLOWED.indexOf(sheetName) === -1) {
    throw new Error('Access denied: cannot toggle ' + sheetName);
  }
  if (!entityId) throw new Error('Missing entity id');

  return withScriptLock(function() {
    var entity = findById(sheetName, entityId);
    if (!entity) throw new Error('Not found in ' + sheetName + ': ' + entityId);

    if (!Object.prototype.hasOwnProperty.call(entity, 'active')) {
      throw new Error('No active column in ' + sheetName +
        '. Run setupSheets() from the Apps Script editor to add it.');
    }

    entity.active = active;
    updateRow(sheetName, entity._rowIndex, entity);
    return { success: true };
  });
}

/**
 * Get uninvoiced items — delegates to the canonical implementation
 * in InvoiceService. This wrapper exists because google.script.run
 * can only pass a single argument (the params object).
 */
function getUninvoicedItems(params) {
  return getUninvoicedItemsInternal(params.businessId, params.dateFrom, params.dateTo, params.contractId);
}

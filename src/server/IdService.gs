/**
 * ID generation service.
 * Generates sequential IDs like "TE-001", "BA-042".
 *
 * Locking note: the Apps Script script lock must be held across the whole
 * read-then-write, not just around the ID scan. `generateId` used to take and
 * release its own lock, which meant an outer critical section (allocateBudget,
 * saveAccountSummary) had its lock dropped the moment it appended a row — so
 * two concurrent requests could both pass a "does this already exist?" guard.
 *
 * The lock-free `nextId` is therefore the primitive, and callers wrap their
 * whole operation in `withScriptLock` (SheetService.gs).
 */

var ID_PREFIXES = {
  'Businesses': 'BIZ',
  'WorkCodes': 'WC',
  'Accounts': 'ACC',
  'BudgetRules': 'BR',
  'Contracts': 'CON',
  'TimeEntries': 'TE',
  'Expenses': 'EXP',
  'BudgetAllocations': 'BA',
  'BudgetPayments': 'BP',
  'AccountSummaries': 'AS'
};

/**
 * Next sequential ID for a sheet. Assumes the caller already holds the lock.
 */
function nextId(sheetName) {
  var prefix = ID_PREFIXES[sheetName];
  if (!prefix) throw new Error('Unknown sheet: ' + sheetName);

  var ss = getSpreadsheet();
  var sheet = ss.getSheetByName(sheetName);
  var lastRow = sheet.getLastRow();

  var nextNum = 1;
  if (lastRow > 1) {
    // Read all IDs in column A to find the max
    var ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    ids.forEach(function(row) {
      var id = (row[0] || '').toString();
      if (!id) return;
      // Extract number from ID like "TE-042"
      var parts = id.split('-');
      var num = parseInt(parts[parts.length - 1], 10);
      if (!isNaN(num) && num >= nextNum) {
        nextNum = num + 1;
      }
    });
  }

  return prefix + '-' + padNumber(nextNum, 3);
}

function padNumber(num, width) {
  var s = num.toString();
  while (s.length < width) s = '0' + s;
  return s;
}

/**
 * ID generation service with locking to prevent duplicates.
 * Generates sequential IDs like "TE-001", "INV-2026-001".
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
  'AccountSummaries': 'AS'
};

/**
 * Generate the next sequential ID for a given sheet.
 * Uses LockService to prevent race conditions.
 */
function generateId(sheetName) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
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
        // Extract number from ID like "TE-042" or "INV-2026-042"
        var parts = id.split('-');
        var num = parseInt(parts[parts.length - 1], 10);
        if (!isNaN(num) && num >= nextNum) {
          nextNum = num + 1;
        }
      });
    }

    // For invoices, include the year
    if (sheetName === 'Invoices') {
      var year = new Date().getFullYear();
      return prefix + '-' + year + '-' + padNumber(nextNum, 3);
    }

    return prefix + '-' + padNumber(nextNum, 3);
  } finally {
    lock.releaseLock();
  }
}

function padNumber(num, width) {
  var s = num.toString();
  while (s.length < width) s = '0' + s;
  return s;
}

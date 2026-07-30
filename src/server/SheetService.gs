/**
 * Generic CRUD operations for Google Sheets.
 * All reads use batch operations (getDataRange) for performance.
 */

var ALLOWED_CLIENT_SHEETS = ['Businesses', 'WorkCodes', 'Accounts', 'BudgetRules', 'BudgetAllocations', 'Contracts'];

/**
 * Run fn while holding the script lock, re-entrantly.
 *
 * Nesting matters here: an operation like allocateBudget must hold one lock
 * across read-check-then-write, but it calls appendRow, which also wants the
 * lock. Releasing on the inner exit would drop the outer function's protection
 * and let two concurrent requests both pass the same "already exists?" check.
 * Only the outermost call acquires and releases; inner calls just nest.
 *
 * A module-level counter is safe because an Apps Script execution is
 * single-threaded — concurrency is across executions, which is exactly what the
 * lock itself serialises.
 */
var _scriptLockDepth = 0;

function withScriptLock(fn, timeoutMs) {
  if (_scriptLockDepth > 0) {
    _scriptLockDepth++;
    try {
      return fn();
    } finally {
      _scriptLockDepth--;
    }
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(timeoutMs || 15000);
  _scriptLockDepth++;
  try {
    return fn();
  } finally {
    _scriptLockDepth--;
    lock.releaseLock();
  }
}

/**
 * Sanitise a cell value to prevent formula injection.
 * Prefixes a leading single-quote when the value starts with =, +, -, or @.
 */
function sanitiseCell(val) {
  if (typeof val !== 'string') return val;
  if (val.length > 0 && '=+-@'.indexOf(val.charAt(0)) !== -1) {
    return "'" + val;
  }
  return val;
}

/**
 * Get all rows from a sheet as an array of objects.
 * Keys are taken from the header row.
 */
function getAll(sheetName) {
  var ss = getSpreadsheet();
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error('Sheet not found: ' + sheetName);

  var data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];

  var headers = data[0];
  var rows = [];
  for (var i = 1; i < data.length; i++) {
    var obj = {};
    for (var j = 0; j < headers.length; j++) {
      var val = data[i][j];
      // Convert Date objects to local-time strings for JSON transport
      // (toISOString() shifts to UTC, corrupting time-only values)
      if (val instanceof Date) {
        var y = val.getFullYear();
        var mo = String(val.getMonth() + 1).padStart(2, '0');
        var d = String(val.getDate()).padStart(2, '0');
        var h = String(val.getHours()).padStart(2, '0');
        var mi = String(val.getMinutes()).padStart(2, '0');
        var s = String(val.getSeconds()).padStart(2, '0');
        if (y < 1900) {
          obj[headers[j]] = h + ':' + mi;
        } else {
          obj[headers[j]] = y + '-' + mo + '-' + d + 'T' + h + ':' + mi + ':' + s;
        }
      } else {
        obj[headers[j]] = val;
      }
    }
    obj._rowIndex = i + 1; // 1-based sheet row number
    rows.push(obj);
  }
  return rows;
}

/**
 * Client-safe wrapper: only allows reading whitelisted sheets.
 */
function getAllClient(sheetName) {
  if (ALLOWED_CLIENT_SHEETS.indexOf(sheetName) === -1) {
    throw new Error('Access denied: ' + sheetName);
  }
  return getAll(sheetName);
}

function isTruthy(val) {
  return val === true || val === 'TRUE' || val === 'true';
}

/**
 * Get active (non-deleted) rows from a reference table.
 */
function getActive(sheetName) {
  return getAll(sheetName).filter(function(row) {
    return isTruthy(row.active);
  });
}

/**
 * Rows are built from the SHEET's headers, so any key in `data` without a
 * matching column would be dropped silently — which is how a whole set of
 * budget percentages once disappeared without an error. Fail loudly instead.
 *
 * The usual cause is a schema addition that has not been migrated yet, so the
 * message says exactly what to do about it.
 */
function assertKnownColumns(sheetName, headers, data) {
  var unknown = Object.keys(data).filter(function(key) {
    return key !== '_rowIndex' && headers.indexOf(key) === -1;
  });
  if (unknown.length === 0) return;

  throw new Error("Sheet '" + sheetName + "' has no column(s): " + unknown.join(', ') +
    '. Run setupSheets() from the Apps Script editor (or Finance Tracker > Run setup / migrations ' +
    'in the spreadsheet menu) to add them, then try again.');
}

/**
 * Append a row to a sheet. Returns the new row data with generated ID.
 */
function appendRow(sheetName, data) {
  // The ID scan and the write must be one atomic step, or two executions hand
  // out the same ID. Re-entrant, so callers already holding the lock keep it.
  return withScriptLock(function() {
    var ss = getSpreadsheet();
    var sheet = ss.getSheetByName(sheetName);
    if (!sheet) throw new Error('Sheet not found: ' + sheetName);

    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    assertKnownColumns(sheetName, headers, data);

    // Generate ID if the first column is an ID field and not provided
    var idField = headers[0];
    if (idField.indexOf('_id') !== -1 && !data[idField]) {
      data[idField] = nextId(sheetName);
    }

    var row = headers.map(function(h) {
      return sanitiseCell(data[h] !== undefined ? data[h] : '');
    });

    var newRow = sheet.getLastRow() + 1;
    sheet.getRange(newRow, 1).setNumberFormat('@');
    sheet.getRange(newRow, 1, 1, row.length).setValues([row]);
    data._rowIndex = newRow;

    return data;
  });
}

/**
 * Update a row by its row index (1-based sheet row number).
 */
function updateRow(sheetName, rowIndex, data) {
  var ss = getSpreadsheet();
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error('Sheet not found: ' + sheetName);

  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  assertKnownColumns(sheetName, headers, data);

  var row = headers.map(function(h) {
    return sanitiseCell(data[h] !== undefined ? data[h] : '');
  });

  sheet.getRange(rowIndex, 1, 1, row.length).setValues([row]);
  return data;
}

/**
 * Delete a row by its row index (1-based sheet row number).
 */
function deleteRow(sheetName, rowIndex) {
  var ss = getSpreadsheet();
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error('Sheet not found: ' + sheetName);
  sheet.deleteRow(rowIndex);
}

/**
 * Compare two ID values allowing for Sheets stripping leading zeros.
 */
function idsMatch(a, b) {
  var sa = String(a);
  var sb = String(b);
  if (sa === sb) return true;
  return sa.replace(/^0+/, '') === sb.replace(/^0+/, '') && (sa !== '' && sb !== '');
}

function normalizeId(id) {
  return String(id).replace(/^0+/, '') || '0';
}

/**
 * Find a row by ID (first column match).
 */
function findById(sheetName, id) {
  var rows = getAll(sheetName);
  if (rows.length === 0) return null;

  var keys = Object.keys(rows[0]).filter(function(k) { return k !== '_rowIndex'; });
  var idField = keys[0];

  var idStr = String(id);
  for (var i = 0; i < rows.length; i++) {
    if (idsMatch(rows[i][idField], idStr)) return rows[i];
  }
  return null;
}

/**
 * Check if a value exists in a specific column of a sheet (case-insensitive).
 * Used for uniqueness validation.
 */
function valueExists(sheetName, column, value) {
  var rows = getAll(sheetName);
  var lower = value.toString().toLowerCase();
  return rows.some(function(row) {
    return row[column] && row[column].toString().toLowerCase() === lower;
  });
}

/**
 * Get rows filtered by a date column's year. Filters server-side to reduce
 * payload across the google.script.run bridge (critical at 10k+ rows).
 */
function getByYear(sheetName, dateColumn, year) {
  var prefix = String(year) + '-';
  return getAll(sheetName).filter(function(row) {
    var d = dateOnly(row[dateColumn]);
    return d !== '' && d.indexOf(prefix) === 0;
  });
}

/**
 * Get rows filtered by a date column within a from/to range.
 * Uses YYYY-MM-DD string comparison to avoid timezone issues.
 */
function getByDateRange(sheetName, dateColumn, dateFrom, dateTo) {
  var rows = getAll(sheetName);
  var fromStr = dateFrom ? dateOnly(dateFrom) : '';
  var toStr = dateTo ? dateOnly(dateTo) : '';

  return rows.filter(function(row) {
    var d = dateOnly(row[dateColumn]);
    if (!d) return false;
    if (fromStr && d < fromStr) return false;
    if (toStr && d > toStr) return false;
    return true;
  });
}

/**
 * Resolve the flexible date filter a client may send:
 *   {dateFrom, dateTo} -> range, either bound blank meaning unbounded
 *   '2026'             -> that year
 *   falsy              -> everything
 *
 * Clearing the From box used to send {dateFrom:'', dateTo:'...'}, which fell
 * through to the year branch and built the prefix '[object Object]-' — matching
 * nothing, so the page reported no data at all.
 */
function getByDateParams(sheetName, dateColumn, params) {
  if (typeof params === 'object' && params !== null) {
    if (!params.dateFrom && !params.dateTo) return getAll(sheetName);
    return getByDateRange(sheetName, dateColumn, params.dateFrom, params.dateTo);
  }
  if (params) return getByYear(sheetName, dateColumn, params);
  return getAll(sheetName);
}

/**
 * Whether the given filter params actually narrow anything.
 */
function isFilteringParams(params) {
  if (typeof params === 'object' && params !== null) {
    return !!(params.dateFrom || params.dateTo);
  }
  return !!params;
}

/**
 * Today's date as YYYY-MM-DD in the script's local timezone (NZ).
 */
function todayLocal() {
  var d = new Date();
  var y = d.getFullYear();
  var m = String(d.getMonth() + 1).padStart(2, '0');
  var day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

/**
 * Extract YYYY-MM-DD from a date value (string or Date).
 * Handles "YYYY-MM-DDThh:mm:ss" and Date objects using local time.
 */
function dateOnly(val) {
  if (!val) return '';
  if (val instanceof Date) {
    var y = val.getFullYear();
    var m = String(val.getMonth() + 1).padStart(2, '0');
    var d = String(val.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + d;
  }
  var s = String(val);
  var match = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : '';
}

/**
 * Find the column index (1-based) for a given header name in a sheet.
 */
function getColumnIndex(sheet, headerName) {
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var idx = headers.indexOf(headerName);
  if (idx === -1) throw new Error('Column not found: ' + headerName + ' in sheet ' + sheet.getName());
  return idx + 1; // 1-based
}

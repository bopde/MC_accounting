/**
 * Account summary service.
 * Tracks monthly account balances, gains, and tax info.
 */

/**
 * Normalise a month value to YYYY-MM format.
 * Google Sheets often coerces "2026-04" into a full Date, so when read back
 * it becomes an ISO string like "2026-04-01T00:00:00.000Z". We extract the
 * YYYY-MM portion regardless of source format.
 */
function normaliseMonth(val) {
  if (val === null || val === undefined || val === '') return '';
  if (val instanceof Date) {
    if (isNaN(val.getTime())) return '';
    var m = val.getMonth() + 1;
    return val.getFullYear() + '-' + (m < 10 ? '0' + m : '' + m);
  }
  var str = String(val).trim();
  var match = str.match(/^(\d{4})-(\d{1,2})/);
  if (match) {
    var mm = parseInt(match[2], 10);
    return match[1] + '-' + (mm < 10 ? '0' + mm : '' + mm);
  }
  return str;
}

/**
 * Add or update a monthly account summary.
 * If a summary already exists for the account+month, updates it.
 */
function saveAccountSummary(data) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var month = normaliseMonth(data.month);

    var existing = getAll('AccountSummaries').find(function(s) {
      return idsMatch(s.account_id, data.account_id) && normaliseMonth(s.month) === month;
    });

    var payload = {
      account_id: data.account_id,
      month: month,
      ending_balance: Number(data.ending_balance) || 0,
      realised_gains: Number(data.realised_gains) || 0,
      unrealised_gains: Number(data.unrealised_gains) || 0,
      tax_paid: Number(data.tax_paid) || 0,
      total_in: Number(data.total_in) || 0,
      total_out: Number(data.total_out) || 0,
      notes: data.notes || ''
    };

    var ss = getSpreadsheet();
    var sheet = ss.getSheetByName('AccountSummaries');
    var monthCol = getColumnIndex(sheet, 'month');

    if (existing) {
      payload._rowIndex = existing._rowIndex;
      updateRow('AccountSummaries', existing._rowIndex, payload);
      sheet.getRange(existing._rowIndex, monthCol).setNumberFormat('@').setValue(month);
      return payload;
    } else {
      var result = appendRow('AccountSummaries', payload);
      sheet.getRange(result._rowIndex, monthCol).setNumberFormat('@').setValue(month);
      return result;
    }
  } finally {
    lock.releaseLock();
  }
}

/**
 * Get account summaries for a specific month, plus previous month for comparison.
 * Returns { current: [...], previous: [...] }.
 */
function getAccountSummariesForMonth(month) {
  var target = normaliseMonth(month);
  var prevMonth = previousMonth(target);
  var allSummaries = getAll('AccountSummaries');

  var current = [];
  var previous = [];
  allSummaries.forEach(function(s) {
    var m = normaliseMonth(s.month);
    s.month = m;
    if (m === target) current.push(s);
    else if (m === prevMonth) previous.push(s);
  });

  var accounts = getAll('Accounts');
  var accMap = {};
  accounts.forEach(function(a) { accMap[String(a.account_id)] = a; });

  function enrich(arr) {
    return arr.map(function(s) {
      var acc = accMap[String(s.account_id)];
      s.account_name = acc ? acc.name : 'Unknown';
      s.account_type = acc ? acc.type : '';
      s.currency = acc ? acc.currency : 'NZD';
      return s;
    });
  }

  return { current: enrich(current), previous: enrich(previous) };
}

/**
 * Compute previous month string from YYYY-MM.
 */
function previousMonth(yyyymm) {
  var parts = yyyymm.split('-');
  var y = parseInt(parts[0], 10);
  var m = parseInt(parts[1], 10) - 1;
  if (m < 1) { m = 12; y--; }
  return y + '-' + (m < 10 ? '0' + m : '' + m);
}

/**
 * Get a year-to-date overview of all accounts.
 * Returns monthly data for each account for the specified year,
 * INCLUDING Jan-Mar of the following year for tax overlap.
 */
function getYearOverview(year) {
  var yearStr = String(year);
  var nextYear = (parseInt(yearStr, 10) + 1).toString();

  var summaries = getAll('AccountSummaries').map(function(s) {
    s.month = normaliseMonth(s.month);
    return s;
  }).filter(function(s) {
    if (!s.month) return false;
    if (s.month.indexOf(yearStr + '-') === 0) return true;
    if (s.month.indexOf(nextYear + '-') === 0) {
      var mNum = parseInt(s.month.split('-')[1], 10);
      return mNum >= 1 && mNum <= 3;
    }
    return false;
  });

  var accounts = getActive('Accounts');

  return {
    accounts: accounts,
    summaries: summaries
  };
}

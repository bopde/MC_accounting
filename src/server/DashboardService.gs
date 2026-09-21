/**
 * Dashboard data service.
 * Bundles all dashboard data into a single RPC to avoid multiple round-trips.
 */
function getDashboardData(params) {
  params = params || {};
  var dateFrom = params.dateFrom || '';
  var dateTo = params.dateTo || '';
  var businessId = params.businessId || '';
  var fromStr = dateFrom ? dateOnly(dateFrom) : '';
  var toStr = dateTo ? dateOnly(dateTo) : '';

  var invoicesRaw = getAll('Invoices');
  var businesses = getAll('Businesses');
  var timeEntriesRaw = getAll('TimeEntries');
  var expensesRaw = getAll('Expenses');
  var allocations = getAll('BudgetAllocations');
  var summaries = getAll('AccountSummaries');
  var accounts = getAll('Accounts').filter(function(a) {
    return isTruthy(a.active);
  });

  var bizMap = {};
  businesses.forEach(function(b) { bizMap[normalizeId(b.business_id)] = b; });

  var invoices = invoicesRaw.filter(function(inv) {
    if (!inRange(inv.created_date, fromStr, toStr)) return false;
    if (businessId && !idsMatch(inv.business_id, businessId)) return false;
    return true;
  }).map(function(inv) {
    var biz = bizMap[normalizeId(inv.business_id)];
    return {
      invoice_id: inv.invoice_id,
      business_id: inv.business_id,
      business_name: biz ? biz.name : 'Unknown',
      currency: biz ? (biz.currency || 'NZD') : 'NZD',
      created_date: inv.created_date,
      total: Number(inv.total) || 0,
      subtotal: Number(inv.subtotal) || 0,
      // Billed time only — ex-GST and excluding expenses.
      time_subtotal: invoiceBilledSubtotal(inv),
      status: inv.status
    };
  });

  var timeEntries = timeEntriesRaw.filter(function(te) {
    if (!inRange(te.date, fromStr, toStr)) return false;
    if (businessId && !idsMatch(te.business_id, businessId)) return false;
    return true;
  }).map(function(te) {
    return {
      date: te.date,
      business_id: te.business_id,
      hours: Number(te.hours) || 0,
      line_total: Number(te.line_total) || 0
    };
  });

  var expenses = expensesRaw.filter(function(exp) {
    if (!inRange(exp.date, fromStr, toStr)) return false;
    if (businessId && !idsMatch(exp.business_id, businessId)) return false;
    return true;
  }).map(function(exp) {
    return {
      date: exp.date,
      business_id: exp.business_id,
      amount: Number(exp.amount) || 0
    };
  });

  var filteredInvoiceIds = {};
  invoices.forEach(function(inv) { filteredInvoiceIds[normalizeId(inv.invoice_id)] = true; });

  var allocatedInvIds = {};
  var allocByKey = {};
  allocations.forEach(function(a) {
    if (!filteredInvoiceIds[normalizeId(a.invoice_id)]) return;
    allocatedInvIds[normalizeId(a.invoice_id)] = true;
    var key = resolveCategoryKey(a);
    if (!key) return;
    if (!allocByKey[key]) allocByKey[key] = { allocated: 0, paid: 0, outstanding: 0 };
    // Through allocationPaidAmount, not the status flag: a part-paid
    // allocation is neither wholly paid nor wholly outstanding, and reading
    // the flag here would make the Dashboard disagree with the Budget page
    // the moment a payment covered less than a whole allocation.
    var amount = Number(a.amount) || 0;
    var paid = allocationPaidAmount(a);
    allocByKey[key].allocated += amount;
    allocByKey[key].paid += paid;
    allocByKey[key].outstanding += round2(amount - paid);
  });

  // Sub-cent dust from summing rounded halves of percentages, which would
  // otherwise render as $0.00 sitting next to a non-zero progress bar.
  Object.keys(allocByKey).forEach(function(k) {
    allocByKey[k].allocated = round2(allocByKey[k].allocated);
    allocByKey[k].paid = round2(allocByKey[k].paid);
    allocByKey[k].outstanding = round2(allocByKey[k].outstanding);
  });

  invoices.forEach(function(inv) {
    inv.allocated = !!allocatedInvIds[normalizeId(inv.invoice_id)];
  });

  // Every bucket, including the Owner Pay transfer — the client needs the draw
  // to work out personal revenue, and `isTransfer` tells it to keep that money
  // out of any total where counting it twice would matter.
  var budget = allCategoryDefs().map(function(def) {
    var d = allocByKey[def.key] || { allocated: 0, paid: 0, outstanding: 0 };
    return {
      category: def.label,
      key: def.key,
      scope: def.scope,
      group: def.group,
      settle: def.settle,
      isTransfer: !!def.isTransfer,
      allocated: d.allocated,
      paid: d.paid,
      outstanding: d.outstanding
    };
  }).filter(function(c) { return c.allocated > 0; });

  var latestByAccount = {};
  summaries.forEach(function(s) {
    var mo = normaliseMonth(s.month);
    if (!mo) return;
    // Skip a month that has not started by the end of the range. Comparing
    // against the 28th instead meant the month you are currently in never
    // showed its balance — a dashboard filtered to "this month" hid the very
    // figure you had just entered.
    if (toStr && mo > toStr.slice(0, 7)) return;
    if (s.ending_balance === '' || s.ending_balance === null || s.ending_balance === undefined) return;
    var key = s.account_id;
    if (!latestByAccount[key] || mo > latestByAccount[key].month) {
      latestByAccount[key] = { month: mo, balance: Number(s.ending_balance) || 0 };
    }
  });

  var accountBalances = [];
  accounts.forEach(function(acc) {
    var latest = latestByAccount[acc.account_id];
    if (latest) {
      accountBalances.push({
        name: acc.name,
        currency: acc.currency || 'NZD',
        balance: latest.balance,
        month: latest.month
      });
    }
  });

  var contracts = getAll('Contracts').filter(function(c) {
    var s = String(c.status || '').trim().toLowerCase();
    if (s === 'complete' || s === 'cancelled' || s === 'void') return false;
    if (businessId && !idsMatch(c.business_id, businessId)) return false;
    return true;
  });

  // Attributed by the one shared rule (ContractService.attributeTimeToContracts)
  // rather than a second copy of it here, which had drifted: untagged time
  // inside two overlapping contracts was counted towards both.
  var attributed = attributeTimeToContracts(contracts, timeEntriesRaw);
  var now = new Date();

  var contractProgress = contracts.map(function(c) {
    var totals = attributed.byContract[normalizeId(c.contract_id)] || { spent: 0, hours: 0 };
    var pace = contractPace(c, totals.spent, now);
    var biz = bizMap[normalizeId(c.business_id)];

    return {
      contract_id: c.contract_id,
      business_id: c.business_id,
      business_name: biz ? biz.name : 'Unknown',
      name: c.name,
      po_number: c.po_number,
      date_from: c.date_from,
      date_to: c.date_to,
      value: pace.value,
      currency: c.currency || 'NZD',
      spent: totals.spent,
      hours: totals.hours,
      days_remaining: pace.days_remaining,
      total_days: pace.total_days,
      expected_pct: pace.expected_pct,
      actual_pct: pace.actual_pct
    };
  });

  return {
    invoices: invoices,
    timeEntries: timeEntries,
    expenses: expenses,
    budget: budget,
    accountBalances: accountBalances,
    contractProgress: contractProgress,
    // Untagged time that two or more overlapping contracts could each claim.
    // Counted against none of them, and reported so the gap is visible rather
    // than looking like work that was never logged.
    unattributedTime: attributed.ambiguous
  };
}

function inRange(dateVal, fromStr, toStr) {
  var d = dateOnly(dateVal);
  if (!d) return false;
  if (fromStr && d < fromStr) return false;
  if (toStr && d > toStr) return false;
  return true;
}

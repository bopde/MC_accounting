/**
 * Contract management service.
 * CRUD operations and progress/spend calculations for contracts.
 */

/** A contract's value must be a positive number, not merely truthy. */
function requireContractValue(value) {
  var n = Number(value);
  if (isNaN(n) || n <= 0) {
    throw new Error('Contract value must be a positive number (got "' + value + '").');
  }
  return n;
}

/** End on or after start, or the period maths below reads as an empty window. */
function requireContractPeriod(from, to) {
  var f = requireDate(from, 'Start date');
  var t = requireDate(to, 'End date');
  if (t < f) throw new Error('End date (' + t + ') cannot be before the start date (' + f + ').');
  return { from: f, to: t };
}

function addContract(params) {
  if (!params.business_id) throw new Error('Business is required.');
  if (!params.name) throw new Error('Contract name is required.');
  if (!params.date_from || !params.date_to) throw new Error('Start and end dates are required.');

  var period = requireContractPeriod(params.date_from, params.date_to);
  var value = requireContractValue(params.value);

  var business = findById('Businesses', params.business_id);
  if (!business) throw new Error('Business not found.');

  return appendRow('Contracts', {
    business_id: params.business_id,
    name: params.name,
    po_number: params.po_number || '',
    date_from: period.from,
    date_to: period.to,
    value: value,
    currency: params.currency || business.currency || 'NZD',
    work_codes: params.work_codes || '',
    status: 'active',
    notes: params.notes || ''
  });
}

/**
 * Edit a contract.
 *
 * Validated on the same terms as adding one: an edit used to accept anything,
 * so a value typed as "12,000" wrote NaN and a swapped pair of dates produced
 * a contract whose progress bar could never be right.
 */
function updateContract(params) {
  return withScriptLock(function() {
    var contract = findById('Contracts', params.contract_id);
    if (!contract) throw new Error('Contract not found.');

    if (params.name !== undefined) {
      if (!String(params.name).trim()) throw new Error('Contract name is required.');
      contract.name = params.name;
    }
    if (params.po_number !== undefined) contract.po_number = params.po_number;

    // Both dates together: checking one against the stored other would let a
    // two-field edit pass field by field and still end up inverted.
    if (params.date_from !== undefined || params.date_to !== undefined) {
      var period = requireContractPeriod(
        params.date_from !== undefined ? params.date_from : contract.date_from,
        params.date_to !== undefined ? params.date_to : contract.date_to);
      contract.date_from = period.from;
      contract.date_to = period.to;
    }

    if (params.value !== undefined) contract.value = requireContractValue(params.value);
    if (params.currency !== undefined) contract.currency = params.currency;
    if (params.work_codes !== undefined) contract.work_codes = params.work_codes;
    if (params.status !== undefined) contract.status = params.status;
    if (params.notes !== undefined) contract.notes = params.notes;

    updateRow('Contracts', contract._rowIndex, contract);
    return contract;
  });
}

function getActiveContracts() {
  return getAll('Contracts').filter(function(c) {
    var s = String(c.status || '').trim().toLowerCase();
    return s !== 'complete' && s !== 'cancelled' && s !== 'void';
  });
}

/**
 * Attribute logged time to contracts.
 *
 * An entry tagged with a contract belongs to that contract, full stop — it
 * says which one it is for, so it never also falls back to a date match.
 *
 * An UNTAGGED entry is attributed to the client's contract whose period covers
 * its date, but only when exactly one does. Where two contracts for the same
 * client overlap, nothing in the data says which one the work was for, and
 * counting it towards both — which is what this used to do, in two separate
 * copies — reported more spend against each contract than the client was ever
 * billed. Those entries are reported separately instead of being invented into
 * one contract or silently doubled into both.
 *
 * @returns {Object} { byContract: { <normalised id>: {spent, hours} },
 *                     ambiguous: {spent, hours, entries} }
 */
function attributeTimeToContracts(contracts, timeEntries) {
  var byContract = {};
  var windows = (contracts || []).map(function(c) {
    var key = normalizeId(c.contract_id);
    byContract[key] = { spent: 0, hours: 0 };
    return {
      key: key,
      businessId: c.business_id,
      from: dateOnly(c.date_from),
      to: dateOnly(c.date_to)
    };
  });

  var ambiguous = { spent: 0, hours: 0, entries: 0 };

  (timeEntries || []).forEach(function(te) {
    var amount = Number(te.line_total) || 0;
    var hours = Number(te.hours) || 0;

    if (te.contract_id) {
      var tagged = byContract[normalizeId(te.contract_id)];
      if (tagged) { tagged.spent += amount; tagged.hours += hours; }
      return;
    }

    var d = dateOnly(te.date);
    if (!d) return;

    var covering = windows.filter(function(w) {
      if (!idsMatch(w.businessId, te.business_id)) return false;
      if (w.from && d < w.from) return false;
      if (w.to && d > w.to) return false;
      return true;
    });

    if (covering.length === 1) {
      byContract[covering[0].key].spent += amount;
      byContract[covering[0].key].hours += hours;
    } else if (covering.length > 1) {
      ambiguous.spent += amount;
      ambiguous.hours += hours;
      ambiguous.entries++;
    }
  });

  return { byContract: byContract, ambiguous: ambiguous };
}

/**
 * Pace: how far through the contract's period we are, versus how much of its
 * value has been spent. Shared so the Dashboard and the Contracts tab cannot
 * report a contract as on track in one place and over in the other.
 */
function contractPace(contract, spent, now) {
  var fromStr = dateOnly(contract.date_from);
  var toStr = dateOnly(contract.date_to);
  now = now || new Date();

  var from = new Date(now.getFullYear(), 0, 1);
  var to = new Date(now.getFullYear(), 0, 1);
  if (fromStr) { var fp = fromStr.split('-'); from = new Date(+fp[0], +fp[1] - 1, +fp[2]); }
  if (toStr) { var tp = toStr.split('-'); to = new Date(+tp[0], +tp[1] - 1, +tp[2]); }

  var totalDays = Math.max(1, (to - from) / 86400000);
  var elapsedDays = Math.max(0, Math.min((now - from) / 86400000, totalDays));
  var value = Number(contract.value) || 0;

  return {
    value: value,
    days_remaining: Math.max(0, Math.ceil((to - now) / 86400000)),
    total_days: Math.ceil(totalDays),
    expected_pct: elapsedDays / totalDays,
    actual_pct: value > 0 ? spent / value : 0
  };
}

/**
 * Calculate spend progress for all active contracts.
 * Returns contract details + hours/dollars spent.
 */
function getContractProgress() {
  var contracts = getActiveContracts();
  if (contracts.length === 0) return [];

  var businesses = getAll('Businesses');
  var bizMap = {};
  businesses.forEach(function(b) { bizMap[normalizeId(b.business_id)] = b; });

  var attributed = attributeTimeToContracts(contracts, getAll('TimeEntries'));
  var now = new Date();

  return contracts.map(function(c) {
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
      work_codes: c.work_codes,
      spent: totals.spent,
      hours: totals.hours,
      days_remaining: pace.days_remaining,
      total_days: pace.total_days,
      expected_pct: pace.expected_pct,
      actual_pct: pace.actual_pct
    };
  });
}

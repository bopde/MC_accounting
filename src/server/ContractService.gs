/**
 * Contract management service.
 * CRUD operations and progress/spend calculations for contracts.
 */

function addContract(params) {
  if (!params.business_id) throw new Error('Business is required.');
  if (!params.name) throw new Error('Contract name is required.');
  if (!params.date_from || !params.date_to) throw new Error('Start and end dates are required.');
  if (!params.value || Number(params.value) <= 0) throw new Error('Contract value must be positive.');

  var business = findById('Businesses', params.business_id);
  if (!business) throw new Error('Business not found.');

  var contract = appendRow('Contracts', {
    business_id: params.business_id,
    name: params.name,
    po_number: params.po_number || '',
    date_from: params.date_from,
    date_to: params.date_to,
    value: Number(params.value),
    currency: params.currency || business.currency || 'NZD',
    work_codes: params.work_codes || '',
    status: 'active',
    notes: params.notes || ''
  });

  return contract;
}

function updateContract(params) {
  var contract = findById('Contracts', params.contract_id);
  if (!contract) throw new Error('Contract not found.');

  if (params.name !== undefined) contract.name = params.name;
  if (params.po_number !== undefined) contract.po_number = params.po_number;
  if (params.date_from !== undefined) contract.date_from = params.date_from;
  if (params.date_to !== undefined) contract.date_to = params.date_to;
  if (params.value !== undefined) contract.value = Number(params.value);
  if (params.currency !== undefined) contract.currency = params.currency;
  if (params.work_codes !== undefined) contract.work_codes = params.work_codes;
  if (params.status !== undefined) contract.status = params.status;
  if (params.notes !== undefined) contract.notes = params.notes;

  updateRow('Contracts', contract._rowIndex, contract);
  return contract;
}

function getActiveContracts() {
  return getAll('Contracts').filter(function(c) {
    var s = String(c.status || '').trim().toLowerCase();
    return s !== 'complete' && s !== 'cancelled' && s !== 'void';
  });
}

/**
 * Calculate spend progress for all active contracts.
 * Returns contract details + hours/dollars spent.
 */
function getContractProgress() {
  var contracts = getActiveContracts();
  if (contracts.length === 0) return [];

  var timeEntries = getAll('TimeEntries');
  var businesses = getAll('Businesses');
  var bizMap = {};
  businesses.forEach(function(b) { bizMap[String(b.business_id)] = b; });

  return contracts.map(function(c) {
    var contractId = c.contract_id;
    var bizId = c.business_id;
    var cFromStr = dateOnly(c.date_from);
    var cToStr = dateOnly(c.date_to);

    var spent = 0;
    var hours = 0;

    timeEntries.forEach(function(te) {
      var linked = idsMatch(te.contract_id, contractId);
      if (!linked) {
        if (!idsMatch(te.business_id, bizId)) return;
        var d = dateOnly(te.date);
        if (d < cFromStr || d > cToStr) return;
        if (te.contract_id && !idsMatch(te.contract_id, contractId)) return;
      }
      spent += Number(te.line_total) || 0;
      hours += Number(te.hours) || 0;
    });

    var value = Number(c.value) || 0;
    var biz = bizMap[String(c.business_id)];
    var now = new Date();
    var from = new Date(now.getFullYear(), 0, 1);
    var to = new Date(now.getFullYear(), 0, 1);
    if (cFromStr) { var fp = cFromStr.split('-'); from = new Date(+fp[0], +fp[1] - 1, +fp[2]); }
    if (cToStr) { var tp = cToStr.split('-'); to = new Date(+tp[0], +tp[1] - 1, +tp[2]); }
    var totalDays = Math.max(1, (to - from) / 86400000);
    var elapsedDays = Math.max(0, Math.min((now - from) / 86400000, totalDays));
    var daysRemaining = Math.max(0, Math.ceil((to - now) / 86400000));
    var expectedPct = elapsedDays / totalDays;
    var actualPct = value > 0 ? spent / value : 0;

    return {
      contract_id: c.contract_id,
      business_id: c.business_id,
      business_name: biz ? biz.name : 'Unknown',
      name: c.name,
      po_number: c.po_number,
      date_from: c.date_from,
      date_to: c.date_to,
      value: value,
      currency: c.currency || 'NZD',
      work_codes: c.work_codes,
      spent: spent,
      hours: hours,
      days_remaining: daysRemaining,
      total_days: Math.ceil(totalDays),
      expected_pct: expectedPct,
      actual_pct: actualPct
    };
  });
}

/**
 * Budget allocation service.
 * Applies budget rules to invoices and tracks money flow.
 *
 * Three-tier allocation model (applied to invoice subtotal, excl GST):
 *   Tier 1 — Withheld (Tax/ACC Withheld): % of Gross → deducted to give Adjusted
 *   Tier 2 — Obligations (Tax/ACC To Pay): % of Adjusted → deducted to give Net
 *   Tier 3 — Distribution (Donate/Save/Invest/Spend): % of Net → must sum to 100%
 *
 * GST Collected is tracked separately from the invoice's gst_amount field.
 *
 * Status model: 'allocated' -> 'paid'
 */

var BUDGET_CATEGORIES = [
  'Tax Withheld', 'Tax To Pay', 'ACC Withheld', 'ACC To Pay',
  'GST Collected',
  'Donate', 'Save', 'Invest', 'Spend'
];

var BUDGET_PCT_FIELDS = [
  'tax_withheld_pct', 'tax_to_pay_pct',
  'acc_withheld_pct', 'acc_to_pay_pct',
  null,
  'donate_pct', 'save_pct', 'invest_pct', 'spend_pct'
];

var WITHHELD_CATEGORIES = ['Tax Withheld', 'ACC Withheld'];
var OBLIGATION_CATEGORIES = ['Tax To Pay', 'ACC To Pay', 'GST Collected'];
var DISTRIBUTION_CATEGORIES = ['Donate', 'Save', 'Invest', 'Spend'];

function computeAllocationAmounts(rule, gross) {
  var withheld = 0;
  BUDGET_CATEGORIES.forEach(function(cat, i) {
    if (WITHHELD_CATEGORIES.indexOf(cat) !== -1) {
      withheld += Math.round(gross * (Number(rule[BUDGET_PCT_FIELDS[i]]) || 0) * 100) / 100;
    }
  });
  var adjusted = gross - withheld;

  var obligations = 0;
  BUDGET_CATEGORIES.forEach(function(cat, i) {
    if (OBLIGATION_CATEGORIES.indexOf(cat) !== -1) {
      obligations += Math.round(adjusted * (Number(rule[BUDGET_PCT_FIELDS[i]]) || 0) * 100) / 100;
    }
  });
  var net = adjusted - obligations;

  var amounts = {};
  BUDGET_CATEGORIES.forEach(function(cat, i) {
    var pct = Number(rule[BUDGET_PCT_FIELDS[i]]) || 0;
    if (WITHHELD_CATEGORIES.indexOf(cat) !== -1) {
      amounts[cat] = Math.round(gross * pct * 100) / 100;
    } else if (OBLIGATION_CATEGORIES.indexOf(cat) !== -1) {
      amounts[cat] = Math.round(adjusted * pct * 100) / 100;
    } else {
      amounts[cat] = Math.round(net * pct * 100) / 100;
    }
  });

  return { amounts: amounts, withheld: withheld, adjusted: adjusted, obligations: obligations, net: net };
}

/**
 * Allocate budget for an invoice using a specific rule.
 */
function allocateBudget(invoiceId, ruleId) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var invoice = findById('Invoices', invoiceId);
    if (!invoice) throw new Error('Invoice not found: ' + invoiceId);

    var existing = getAll('BudgetAllocations').filter(function(a) {
      return idsMatch(a.invoice_id, invoiceId);
    });
    if (existing.length > 0) {
      throw new Error('Budget already allocated for this invoice.');
    }

    var rule = findById('BudgetRules', ruleId);
    if (!rule) throw new Error('Budget rule not found: ' + ruleId);

    var gross = (invoice.time_subtotal != null && invoice.time_subtotal !== '')
      ? Number(invoice.time_subtotal) : (Number(invoice.subtotal) || 0);
    var gstAmount = isTruthy(invoice.include_gst) ? (Number(invoice.gst_amount) || 0) : 0;
    var today = todayLocal();
    var calc = computeAllocationAmounts(rule, gross);

    var allocations = [];
    BUDGET_CATEGORIES.forEach(function(cat, i) {
      if (cat === 'GST Collected') {
        if (gstAmount > 0) {
          allocations.push(appendRow('BudgetAllocations', {
            invoice_id: invoiceId,
            category: 'GST Collected',
            percentage: 0,
            amount: gstAmount,
            status: 'allocated',
            transfer_date: '',
            notes: ''
          }));
        }
        return;
      }
      var pct = Number(rule[BUDGET_PCT_FIELDS[i]]) || 0;
      var isWithheld = WITHHELD_CATEGORIES.indexOf(cat) !== -1;

      var allocation = appendRow('BudgetAllocations', {
        invoice_id: invoiceId,
        category: cat,
        percentage: pct,
        amount: calc.amounts[cat],
        status: isWithheld ? 'paid' : 'allocated',
        transfer_date: isWithheld ? today : '',
        notes: isWithheld ? 'Auto-paid (withheld by payer)' : ''
      });
      allocations.push(allocation);
    });

    invoice.budget_rule_id = ruleId;
    updateRow('Invoices', invoice._rowIndex, invoice);

    return allocations;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Toggle allocation status between 'allocated' and 'paid'.
 */
function updateAllocationStatus(allocationId, newStatus, transferDate, notes) {
  newStatus = normaliseAllocationStatus(newStatus);

  var allocs = getAll('BudgetAllocations');
  var alloc = allocs.find(function(a) { return idsMatch(a.allocation_id, allocationId); });
  if (!alloc) throw new Error('Allocation not found: ' + allocationId);

  alloc.status = newStatus;
  if (newStatus === 'paid') {
    alloc.transfer_date = transferDate || todayLocal();
    if (notes) alloc.notes = notes;
  } else {
    alloc.transfer_date = '';
    alloc.notes = '';
  }
  updateRow('BudgetAllocations', alloc._rowIndex, alloc);
  return alloc;
}

function normaliseAllocationStatus(status) {
  if (status === 'paid' || status === 'transferred' || status === 'reconciled') return 'paid';
  return 'allocated';
}

/**
 * Get budget summary across all invoices.
 */
function getBudgetSummary(params) {
  var invoices;
  if (typeof params === 'object' && params !== null && params.dateFrom) {
    invoices = getByDateRange('Invoices', 'created_date', params.dateFrom, params.dateTo);
  } else if (params) {
    invoices = getByYear('Invoices', 'created_date', params);
  } else {
    invoices = getAll('Invoices');
  }
  var invoiceIdList = invoices.map(function(inv) { return String(inv.invoice_id); });

  var allAllocations = getAll('BudgetAllocations');
  var allocations = params
    ? allAllocations.filter(function(a) {
        return invoiceIdList.some(function(id) { return idsMatch(a.invoice_id, id); });
      })
    : allAllocations;
  var businesses = getAll('Businesses');

  var bizMap = {};
  businesses.forEach(function(b) { bizMap[normalizeId(b.business_id)] = b.name; });

  var invMap = {};
  invoices.forEach(function(inv) { invMap[normalizeId(inv.invoice_id)] = inv; });

  var byCat = {};
  BUDGET_CATEGORIES.forEach(function(cat) {
    byCat[cat] = {
      category: cat,
      isWithheld: WITHHELD_CATEGORIES.indexOf(cat) !== -1,
      allocated: 0,
      paid: 0,
      outstanding: 0,
      items: []
    };
  });

  allocations.forEach(function(a) {
    var cat = a.category;
    if (!byCat[cat]) return;

    var amount = Number(a.amount) || 0;
    var status = normaliseAllocationStatus(a.status);
    var inv = invMap[normalizeId(a.invoice_id)] || {};

    byCat[cat].allocated += amount;
    if (status === 'paid') {
      byCat[cat].paid += amount;
    } else {
      byCat[cat].outstanding += amount;
    }

    byCat[cat].items.push({
      allocation_id: a.allocation_id,
      invoice_id: a.invoice_id,
      business_name: bizMap[normalizeId(inv.business_id)] || 'Unknown',
      amount: amount,
      status: status,
      transfer_date: a.transfer_date || '',
      notes: a.notes || ''
    });
  });

  var categories = BUDGET_CATEGORIES.map(function(c) { return byCat[c]; });

  var totals = {
    allocated: 0, paid: 0, outstanding: 0,
    taxWithheld: byCat['Tax Withheld'].paid,
    taxToPayAllocated: byCat['Tax To Pay'].allocated,
    taxToPayPaid: byCat['Tax To Pay'].paid,
    taxToPayOutstanding: byCat['Tax To Pay'].outstanding,
    accWithheld: byCat['ACC Withheld'].paid,
    accToPayAllocated: byCat['ACC To Pay'].allocated,
    accToPayPaid: byCat['ACC To Pay'].paid,
    accToPayOutstanding: byCat['ACC To Pay'].outstanding,
    gstAllocated: byCat['GST Collected'].allocated,
    gstPaid: byCat['GST Collected'].paid,
    gstOutstanding: byCat['GST Collected'].outstanding,
    spendAllocated: byCat['Spend'].allocated, spendPaid: byCat['Spend'].paid, spendOutstanding: byCat['Spend'].outstanding,
    saveAllocated: byCat['Save'].allocated, savePaid: byCat['Save'].paid, saveOutstanding: byCat['Save'].outstanding,
    donateAllocated: byCat['Donate'].allocated, donatePaid: byCat['Donate'].paid, donateOutstanding: byCat['Donate'].outstanding,
    investAllocated: byCat['Invest'].allocated, investPaid: byCat['Invest'].paid, investOutstanding: byCat['Invest'].outstanding
  };
  categories.forEach(function(c) {
    totals.allocated += c.allocated;
    totals.paid += c.paid;
    totals.outstanding += c.outstanding;
  });

  return { categories: categories, totals: totals };
}

/**
 * Validate budget rule: distribution categories (Donate/Save/Invest/Spend)
 * must sum to 100% of net.
 */
function validateBudgetRule(rule) {
  var distSum = 0;
  BUDGET_CATEGORIES.forEach(function(cat, i) {
    if (DISTRIBUTION_CATEGORIES.indexOf(cat) !== -1) {
      distSum += Number(rule[BUDGET_PCT_FIELDS[i]]) || 0;
    }
  });

  if (Math.abs(distSum - 1.0) > 0.001) {
    throw new Error('Distribution categories (Donate, Save, Invest, Spend) must sum to 100%. Current: ' + (distSum * 100).toFixed(1) + '%');
  }
  return true;
}

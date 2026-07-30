/**
 * Budget allocation service.
 * Applies budget rules to invoices and tracks money flow.
 *
 * Two models are supported:
 *
 *   'company' (current) — a two-scope cascade. Business money (GST, Business
 *     Tax, Business ACC, Reserve) stays in the business account; the remainder
 *     becomes Owner Pay, which is drawn to the personal account and split
 *     across Personal Tax, Personal ACC, Donate, Save, Invest and Spend.
 *
 *   'sole_trader' (legacy) — the original three-tier cascade, kept so
 *     historical rules still work and old allocations still render.
 *
 * Every category definition, percentage field and the whole company cascade
 * live in BudgetCategories.gs. Nothing in this file hardcodes a bucket.
 *
 * Status model: 'allocated' -> 'paid'
 */

/**
 * Legacy three-tier cascade (applied to the invoice subtotal, excl GST):
 *   Tier 1 — Withheld (Tax/ACC Withheld): % of Gross → deducted to give Adjusted
 *   Tier 2 — Obligations (Tax/ACC To Pay): % of Adjusted → deducted to give Net
 *   Tier 3 — Distribution (Donate/Save/Invest/Spend): % of Net → must sum to 100%
 */
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
 * The allocation base for an invoice: billed hours only, ex-GST.
 * Expenses are pass-throughs and are deliberately excluded.
 */
function invoiceAllocationBasis(invoice) {
  var gross = (invoice.time_subtotal != null && invoice.time_subtotal !== '')
    ? Number(invoice.time_subtotal) : (Number(invoice.subtotal) || 0);
  var gstAmount = isTruthy(invoice.include_gst) ? (Number(invoice.gst_amount) || 0) : 0;
  return { gross: gross, gstAmount: gstAmount };
}

/**
 * Shape the legacy cascade's output like the company cascade's, so preview
 * and allocation code paths stay identical regardless of model.
 */
function computeLegacyAllocation(rule, gross, gstAmount) {
  var calc = computeAllocationAmounts(rule, gross);

  var lines = LEGACY_CATEGORY_DEFS.map(function(d) {
    return {
      key: d.key,
      label: d.label,
      scope: d.scope,
      group: d.group,
      basis: d.basis,
      settle: d.settle,
      isTransfer: false,
      pct: d.pctField ? (Number(rule[d.pctField]) || 0) : null,
      amount: d.basis === 'invoice_gst' ? gstAmount : (calc.amounts[d.label] || 0)
    };
  });

  return {
    lines: lines,
    stages: {
      gross: gross,
      withheld: calc.withheld,
      adjusted: calc.adjusted,
      gst: gstAmount,
      obligations: calc.obligations,
      net: calc.net
    },
    total: round2(lines.reduce(function(s, l) { return s + l.amount; }, 0))
  };
}

/**
 * Build the full set of allocation lines for an invoice + rule, without
 * writing anything. Both allocateBudget and previewAllocation go through
 * here, so a preview can never disagree with what gets written.
 */
function buildAllocationPlan(invoice, rule) {
  var basis = invoiceAllocationBasis(invoice);
  var model = ruleModel(rule);

  var plan = (model === MODEL_COMPANY)
    ? computeCompanyAllocation(rule, basis.gross, basis.gstAmount)
    : computeLegacyAllocation(rule, basis.gross, basis.gstAmount);

  plan.model = model;
  return plan;
}

/**
 * Preview an allocation. Returns exactly what allocateBudget would write.
 */
function previewAllocation(invoiceId, ruleId) {
  var invoice = findById('Invoices', invoiceId);
  if (!invoice) throw new Error('Invoice not found: ' + invoiceId);

  var rule = findById('BudgetRules', ruleId);
  if (!rule) throw new Error('Budget rule not found: ' + ruleId);

  var business = invoice.business_id ? findById('Businesses', invoice.business_id) : null;
  var plan = buildAllocationPlan(invoice, rule);

  return {
    invoice_id: invoice.invoice_id,
    business_name: business ? business.name : 'Unknown',
    currency: (business && business.currency) || 'NZD',
    rule: { rule_id: rule.rule_id, name: rule.name, model: plan.model },
    model: plan.model,
    lines: plan.lines.filter(function(l) { return l.amount !== 0; }),
    stages: plan.stages,
    total: plan.total
  };
}

/**
 * Allocate budget for an invoice using a specific rule.
 * Lines that come to zero are skipped — there is nothing to track.
 */
function allocateBudget(invoiceId, ruleId) {
  // One lock for the whole check-then-write: the duplicate guard below is only
  // meaningful if no other execution can slip between it and the appends.
  return withScriptLock(function() {
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

    var plan = buildAllocationPlan(invoice, rule);
    var today = todayLocal();

    var allocations = [];
    plan.lines.forEach(function(line) {
      if (line.amount === 0) return;
      var autoPaid = line.settle === 'auto_paid';

      allocations.push(appendRow('BudgetAllocations', {
        invoice_id: invoiceId,
        category: line.label,
        category_key: line.key,
        scope: line.scope,
        percentage: line.pct == null ? '' : line.pct,
        amount: line.amount,
        status: autoPaid ? 'paid' : 'allocated',
        transfer_date: autoPaid ? today : '',
        notes: autoPaid ? 'Auto-paid (withheld by payer)' : ''
      }));
    });

    // Otherwise the invoice would be stamped with a rule it never used, and
    // would still show as unallocated because no rows exist.
    if (allocations.length === 0) {
      throw new Error('Nothing to allocate — this invoice has no billable value.');
    }

    invoice.budget_rule_id = ruleId;
    updateRow('Invoices', invoice._rowIndex, invoice);

    return allocations;
  });
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
 * Get budget summary across all invoices, grouped by scope.
 *
 * Owner Pay is reported separately as `bridge` and excluded from every money
 * total — it is a transfer between two of your own accounts, so counting it
 * would double every personal dollar.
 */
function getBudgetSummary(params) {
  var invoices = getByDateParams('Invoices', 'created_date', params);
  var isFiltered = isFilteringParams(params);

  // Normalise the invoice IDs into a map once: comparing every allocation
  // against every invoice with idsMatch was O(n*m) string work.
  var inRangeIds = {};
  invoices.forEach(function(inv) { inRangeIds[normalizeId(inv.invoice_id)] = true; });

  var allAllocations = getAll('BudgetAllocations');
  var allocations = isFiltered
    ? allAllocations.filter(function(a) { return !!inRangeIds[normalizeId(a.invoice_id)]; })
    : allAllocations;
  var businesses = getAll('Businesses');

  var bizMap = {};
  businesses.forEach(function(b) { bizMap[normalizeId(b.business_id)] = b.name; });

  var invMap = {};
  invoices.forEach(function(inv) { invMap[normalizeId(inv.invoice_id)] = inv; });

  var byKey = {};
  allCategoryDefs().forEach(function(def) {
    byKey[def.key] = {
      key: def.key,
      category: def.label,
      scope: def.scope,
      group: def.group,
      settle: def.settle,
      isTransfer: !!def.isTransfer,
      isWithheld: def.settle === 'auto_paid',
      allocated: 0,
      paid: 0,
      outstanding: 0,
      items: []
    };
  });

  allocations.forEach(function(a) {
    var key = resolveCategoryKey(a);
    var cat = byKey[key];
    if (!cat) return;

    var amount = Number(a.amount) || 0;
    var status = normaliseAllocationStatus(a.status);
    var inv = invMap[normalizeId(a.invoice_id)] || {};

    cat.allocated += amount;
    if (status === 'paid') {
      cat.paid += amount;
    } else {
      cat.outstanding += amount;
    }

    cat.items.push({
      allocation_id: a.allocation_id,
      invoice_id: a.invoice_id,
      business_name: bizMap[normalizeId(inv.business_id)] || 'Unknown',
      amount: amount,
      status: status,
      transfer_date: a.transfer_date || '',
      notes: a.notes || ''
    });
  });

  // Only buckets that actually carry allocations are worth rendering.
  var used = allCategoryDefs().map(function(def) { return byKey[def.key]; })
    .filter(function(c) { return c.items.length > 0; });

  var scopes = BUDGET_SCOPES.map(function(s) {
    var cats = used.filter(function(c) { return c.scope === s.scope; });
    var group = {
      scope: s.scope,
      label: s.label,
      accountHint: s.accountHint,
      categories: cats,
      allocated: 0,
      paid: 0,
      outstanding: 0
    };
    cats.forEach(function(c) {
      group.allocated += c.allocated;
      group.paid += c.paid;
      group.outstanding += c.outstanding;
    });
    return group;
  }).filter(function(g) { return g.categories.length > 0; });

  var totals = { allocated: 0, paid: 0, outstanding: 0, allocationCount: 0 };
  used.forEach(function(c) {
    if (c.isTransfer) return;
    totals.allocationCount += c.items.length;
    totals.allocated += c.allocated;
    totals.paid += c.paid;
    totals.outstanding += c.outstanding;
  });

  var bridgeCat = byKey.owner_pay;
  var bridge = {
    allocated: bridgeCat.allocated,
    paid: bridgeCat.paid,
    outstanding: bridgeCat.outstanding
  };

  // What should still be sitting in each account: everything allocated but
  // not yet paid out, set aside or moved on.
  var accountHoldings = { business: 0, personal: 0, legacy: 0 };
  used.forEach(function(c) {
    if (c.isTransfer) return;
    if (accountHoldings[c.scope] === undefined) return;
    accountHoldings[c.scope] += c.outstanding;
  });

  return {
    scopes: scopes,
    categories: used,
    bridge: bridge,
    accountHoldings: accountHoldings,
    totals: totals
  };
}

/**
 * Validate a budget rule against the model it declares.
 */
function validateBudgetRule(rule) {
  if (ruleModel(rule) === MODEL_COMPANY) return validateCompanyRule(rule);
  return validateLegacyBudgetRule(rule);
}

/**
 * Legacy validation: distribution categories (Donate/Save/Invest/Spend)
 * must sum to 100% of net.
 */
function validateLegacyBudgetRule(rule) {
  var distSum = 0;
  BUDGET_CATEGORIES.forEach(function(cat, i) {
    if (DISTRIBUTION_CATEGORIES.indexOf(cat) !== -1) {
      distSum += Number(rule[BUDGET_PCT_FIELDS[i]]) || 0;
    }
  });

  if (Math.abs(distSum - 1.0) > 0.001) {
    throw new Error('Distribution categories (' + DISTRIBUTION_CATEGORIES.join(', ') + ') must sum to 100%. Current: ' + (distSum * 100).toFixed(1) + '%');
  }
  return true;
}

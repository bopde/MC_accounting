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
  gross = round2(gross);

  var withheld = 0;
  BUDGET_CATEGORIES.forEach(function(cat, i) {
    if (WITHHELD_CATEGORIES.indexOf(cat) !== -1) {
      withheld += round2(gross * (Number(rule[BUDGET_PCT_FIELDS[i]]) || 0));
    }
  });
  withheld = round2(withheld);

  // Rounded at every stage, like the company cascade: an unrounded `adjusted`
  // carries binary-float dust into every percentage taken off it.
  var adjusted = round2(gross - withheld);

  var obligations = 0;
  BUDGET_CATEGORIES.forEach(function(cat, i) {
    if (OBLIGATION_CATEGORIES.indexOf(cat) !== -1) {
      obligations += round2(adjusted * (Number(rule[BUDGET_PCT_FIELDS[i]]) || 0));
    }
  });
  obligations = round2(obligations);

  var net = round2(adjusted - obligations);

  var amounts = {};
  BUDGET_CATEGORIES.forEach(function(cat, i) {
    var pct = Number(rule[BUDGET_PCT_FIELDS[i]]) || 0;
    if (WITHHELD_CATEGORIES.indexOf(cat) !== -1) {
      amounts[cat] = round2(gross * pct);
    } else if (OBLIGATION_CATEGORIES.indexOf(cat) !== -1) {
      amounts[cat] = round2(adjusted * pct);
    }
  });

  // Distribution last, with the residual taking the difference. Four shares of
  // net, each rounded to the cent, do not sum to net — so without this the
  // lines came to a cent or two less than the invoice, and the sole-trader
  // cascade quietly failed the conservation the company one guarantees.
  var residualLabel = getCategoryDef(LEGACY_RESIDUAL_KEY).label;
  var distributed = 0;
  BUDGET_CATEGORIES.forEach(function(cat, i) {
    if (DISTRIBUTION_CATEGORIES.indexOf(cat) === -1) return;
    if (cat === residualLabel) return;
    var amt = round2(net * (Number(rule[BUDGET_PCT_FIELDS[i]]) || 0));
    amounts[cat] = amt;
    distributed += amt;
  });
  amounts[residualLabel] = round2(net - round2(distributed));

  return { amounts: amounts, withheld: withheld, adjusted: adjusted, obligations: obligations, net: net };
}

/**
 * The allocation base for an invoice: billed hours only, ex-GST.
 * Expenses are pass-throughs and are deliberately excluded.
 */
function invoiceAllocationBasis(invoice) {
  var gstAmount = isTruthy(invoice.include_gst) ? (Number(invoice.gst_amount) || 0) : 0;
  return { gross: invoiceBilledSubtotal(invoice), gstAmount: gstAmount };
}

/**
 * What an invoice billed for time: ex-GST, excluding expenses.
 *
 * `time_subtotal` arrived with GST support. Invoices raised before that stored
 * only `subtotal`, which bundles expenses in, so for those rows this is the
 * closest figure available rather than an exact one. Defined once because both
 * the budget cascade and the dashboard's Invoiced column depend on it agreeing.
 */
function invoiceBilledSubtotal(invoice) {
  if (!invoice) return 0;
  return (invoice.time_subtotal != null && invoice.time_subtotal !== '')
    ? (Number(invoice.time_subtotal) || 0)
    : (Number(invoice.subtotal) || 0);
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
 * The sole-trader cascade is FROZEN: it still reads, it no longer writes.
 *
 * It exists for invoices raised before the company did, and that set can never
 * grow by one row. Letting new allocations use it kept a second cascade alive
 * in every grouping and every change — a `legacy_` twin for each bucket — to
 * serve data that is finished. Historical allocations go on rendering exactly
 * as they did; only starting a NEW one on an old rule is refused.
 */
function assertRuleUsableForNewAllocation(rule) {
  if (ruleModel(rule) !== MODEL_SOLE_TRADER) return;
  throw new Error('"' + (rule.name || rule.rule_id) + '" is a pre-company (sole trader) rule. ' +
    'Those are kept so historical allocations still read, but new ones cannot use them — ' +
    'allocate against a company rule instead.');
}

/**
 * Preview an allocation. Returns exactly what allocateBudget would write.
 */
function previewAllocation(invoiceId, ruleId) {
  var invoice = findById('Invoices', invoiceId);
  if (!invoice) throw new Error('Invoice not found: ' + invoiceId);

  var rule = findById('BudgetRules', ruleId);
  if (!rule) throw new Error('Budget rule not found: ' + ruleId);
  // Refused here as well as on the write, so the message arrives before the
  // user has read a preview of something that cannot be confirmed.
  assertRuleUsableForNewAllocation(rule);

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

    // The rule is checked before the state is: being handed a rule that cannot
    // be used is a fact about the request, and saying so beats reporting
    // whatever the invoice happens to be in the middle of.
    var rule = findById('BudgetRules', ruleId);
    if (!rule) throw new Error('Budget rule not found: ' + ruleId);
    assertRuleUsableForNewAllocation(rule);

    var existing = getAll('BudgetAllocations').filter(function(a) {
      return idsMatch(a.invoice_id, invoiceId);
    });
    if (existing.length > 0) {
      throw new Error('Budget already allocated for this invoice.');
    }

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
        paid_amount: autoPaid ? line.amount : 0,
        entry_type: ENTRY_ALLOCATION,
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
 * Settle or un-settle a single allocation outright.
 *
 * Kept for the odd one-off correction; the Money Flow page pays by category
 * through payBudgetCategories instead. `paid_amount` is moved with `status`
 * so the two can never disagree.
 */
function updateAllocationStatus(allocationId, newStatus, transferDate, notes) {
  newStatus = normaliseAllocationStatus(newStatus);

  return withScriptLock(function() {
    var allocs = getAll('BudgetAllocations');
    var alloc = allocs.find(function(a) { return idsMatch(a.allocation_id, allocationId); });
    if (!alloc) throw new Error('Allocation not found: ' + allocationId);

    // A credit owes nothing, so settling it "in full" would set its paid
    // amount to zero and quietly erase the credit. A correction is settled by
    // the payment that created it. Neither is a row to toggle by hand — undo
    // the payment instead, which removes them properly.
    if (!isCascadeLine(alloc)) {
      throw new Error('That row is a ' + allocationEntryType(alloc) + ' created by a payment, ' +
        'not an allocation to settle. Undo the payment under Budget > Money Flow > History.');
    }

    alloc.status = newStatus;
    if (newStatus === 'paid') {
      alloc.paid_amount = Number(alloc.amount) || 0;
      alloc.transfer_date = transferDate || todayLocal();
      if (notes) alloc.notes = notes;
    } else {
      alloc.paid_amount = 0;
      alloc.transfer_date = '';
      alloc.notes = '';
    }
    updateRow('BudgetAllocations', alloc._rowIndex, alloc);
    return alloc;
  });
}

function normaliseAllocationStatus(status) {
  if (status === 'paid' || status === 'transferred' || status === 'reconciled') return 'paid';
  return 'allocated';
}

/**
 * The three kinds of row BudgetAllocations holds.
 *
 * ENTRY_ALLOCATION is a line the cascade wrote from an invoice. The other two
 * only ever come from a payment that exceeded what was outstanding, and the
 * person recording it said which it was:
 *
 *   ENTRY_ADJUSTMENT — "I owed more than was allocated." Raises what is owed,
 *                      and is settled by the same payment that revealed it.
 *   ENTRY_CREDIT     — "I paid more than I owed." Owes nothing and is paid,
 *                      so the bucket's outstanding goes negative and the next
 *                      allocation to it is covered before any cash is needed.
 *
 * Keeping them out of ENTRY_ALLOCATION is what lets an invoice's own lines go
 * on summing to exactly what it billed, however much is later paid against it.
 */
var ENTRY_ALLOCATION = '';
var ENTRY_ADJUSTMENT = 'adjustment';
var ENTRY_CREDIT = 'credit';

function allocationEntryType(alloc) {
  var raw = String((alloc && alloc.entry_type) || '').trim().toLowerCase();
  return (raw === ENTRY_ADJUSTMENT || raw === ENTRY_CREDIT) ? raw : ENTRY_ALLOCATION;
}

/** A row the cascade wrote, as opposed to one a payment added afterwards. */
function isCascadeLine(alloc) {
  return allocationEntryType(alloc) === ENTRY_ALLOCATION;
}

/**
 * How much of an allocation has actually been paid.
 *
 * A blank `paid_amount` means the row predates partial payments, so `status`
 * is the whole truth: 'paid' was paid in full, anything else was not paid at
 * all. Never more than the allocation itself, so a stray figure in the sheet
 * cannot make a bucket look over-paid.
 */
function allocationPaidAmount(alloc) {
  var amount = Number(alloc.amount) || 0;
  var raw = alloc.paid_amount;

  if (raw === '' || raw === null || raw === undefined) {
    return normaliseAllocationStatus(alloc.status) === 'paid' ? amount : 0;
  }

  var paid = Number(raw) || 0;
  if (paid < 0) return 0;

  // A credit row owes nothing and is entirely paid, so the cap that stops a
  // stray figure making a bucket look over-paid would erase it.
  if (allocationEntryType(alloc) === ENTRY_CREDIT) return round2(paid);

  return paid > amount ? amount : round2(paid);
}

/** What is still owed on an allocation. */
function allocationOutstanding(alloc) {
  return round2((Number(alloc.amount) || 0) - allocationPaidAmount(alloc));
}

/**
 * Payment rows, tolerating a spreadsheet that has not been migrated yet.
 * The app warns about the missing sheet separately (checkSchema); until then
 * the page should still render rather than failing outright.
 */
function budgetPaymentRows() {
  try {
    return getAll('BudgetPayments');
  } catch (e) {
    return [];
  }
}

/**
 * Refuse to record a payment before the sheet that records payments exists.
 *
 * Checked up front because the allocations are settled first and the payment
 * row written last: without this, a spreadsheet that has not been migrated
 * would mark the money as paid and then lose the payment that did it, leaving
 * nothing to undo.
 */
function assertPaymentsSheet() {
  try {
    getAll('BudgetPayments');
  } catch (e) {
    throw new Error('Payments cannot be recorded yet — the BudgetPayments sheet is missing. ' +
      'Run Finance Tracker > Run setup / migrations in the spreadsheet menu, then try again.');
  }
}

/** 'BA-002:252;BA-003:18' -> [{allocation_id:'BA-002', amount:252}, ...] */
function parseCoveredAllocations(covered) {
  return String(covered == null ? '' : covered)
    .split(';')
    .map(function(part) { return part.trim(); })
    .filter(function(part) { return part.length > 0; })
    .map(function(part) {
      var at = part.lastIndexOf(':');
      if (at === -1) return { allocation_id: part, amount: 0 };
      return {
        allocation_id: part.slice(0, at),
        amount: Number(part.slice(at + 1)) || 0
      };
    });
}

function formatCoveredAllocations(applied) {
  return applied.map(function(a) { return a.allocation_id + ':' + a.amount; }).join(';');
}

/**
 * Record a payment against one or more budget categories.
 *
 * The money is applied to that category's outstanding allocations oldest
 * invoice first, splitting the last one where the payment does not cover it
 * in full. One row goes into BudgetPayments naming every allocation it
 * touched and by how much, so the payment reads — and can be undone — as the
 * single act it was.
 *
 * `categoryKeys` takes several keys because a box on the Money Flow page can
 * merge a company bucket with its sole-trader counterpart (personal tax is
 * per_tax + legacy_tax), and one payment settles both.
 *
 * `params` is the page's date filter. Only allocations whose invoice falls in
 * that range are eligible, so "pay the remaining" means exactly the figure on
 * screen and never reaches back into a period the user is not looking at.
 */
function payBudgetCategories(categoryKeys, amount, paymentDate, notes, params, surplusMode) {
  var keys = (Array.isArray(categoryKeys) ? categoryKeys : String(categoryKeys || '').split(','))
    .map(function(k) { return String(k).trim(); })
    .filter(function(k) { return k.length > 0; });

  if (keys.length === 0) throw new Error('No budget category given.');

  var unknown = keys.filter(function(k) { return !getCategoryDef(k); });
  if (unknown.length) throw new Error('Unknown budget category: ' + unknown.join(', '));

  var payAmount = round2(Number(amount) || 0);
  if (!(payAmount > 0)) throw new Error('Enter a payment amount greater than zero.');

  var label = keys.map(function(k) { return getCategoryDef(k).label; }).join(' + ');

  var mode = String(surplusMode || SURPLUS_REFUSE).trim().toLowerCase();
  if ([SURPLUS_REFUSE, SURPLUS_OVERPAY, SURPLUS_CORRECT].indexOf(mode) === -1) {
    throw new Error('Unknown way to handle a surplus: "' + surplusMode + '".');
  }

  return withScriptLock(function() {
    assertPaymentsSheet();

    var eligible = eligibleAllocations(keys, params);

    var outstanding = round2(eligible.reduce(function(sum, a) {
      return sum + allocationOutstanding(a);
    }, 0));

    if (outstanding <= 0 && mode === SURPLUS_REFUSE) {
      throw new Error('Nothing outstanding for ' + label + ' in this date range.');
    }
    // Half a cent of slack: the figure on screen is rounded, so "pay the
    // remaining" must not be rejected for matching it exactly.
    var surplus = round2(payAmount - outstanding);
    if (surplus > 0.005) {
      if (mode === SURPLUS_REFUSE) {
        throw new Error('That is ' + formatMoneyPlain(surplus) + ' more than is outstanding for ' +
          label + ' in this date range (' + outstanding.toFixed(2) + '). Say whether it is an ' +
          'overpayment to hold as credit, or a correction to what was owed.');
      }
    } else {
      surplus = 0;
    }

    var date = dateOnly(paymentDate) || todayLocal();
    var remaining = payAmount;
    var applied = [];

    eligible.forEach(function(alloc) {
      if (remaining <= 0.004) return;
      var owed = allocationOutstanding(alloc);
      if (owed <= 0) return;

      var take = round2(Math.min(owed, remaining));
      if (take <= 0) return;

      var paid = round2(allocationPaidAmount(alloc) + take);
      alloc.paid_amount = paid;
      // Within a cent of the full amount counts as settled: percentages of a
      // percentage leave sub-cent dust that would otherwise sit outstanding
      // forever with no way to clear it.
      if (Math.abs((Number(alloc.amount) || 0) - paid) < 0.005) {
        alloc.status = 'paid';
        alloc.transfer_date = date;
      } else {
        alloc.status = 'allocated';
        alloc.transfer_date = '';
      }
      updateRow('BudgetAllocations', alloc._rowIndex, alloc);

      applied.push({ allocation_id: alloc.allocation_id, amount: take });
      remaining = round2(remaining - take);
    });

    // Whatever the allocations could not absorb becomes one extra row, of the
    // kind the person chose. It is listed in `covered` like any other, so undo
    // reverses it by the same path as the rest of the payment.
    if (remaining > 0.004) {
      var surplusRow = appendRow('BudgetAllocations', {
        invoice_id: bucketAnchorInvoice(keys, params, eligible),
        category: label,
        category_key: keys[0],
        scope: getCategoryDef(keys[0]).scope,
        percentage: '',
        amount: mode === SURPLUS_CORRECT ? remaining : 0,
        status: 'paid',
        paid_amount: remaining,
        entry_type: mode === SURPLUS_CORRECT ? ENTRY_ADJUSTMENT : ENTRY_CREDIT,
        transfer_date: date,
        notes: mode === SURPLUS_CORRECT
          ? 'Correction: owed more than was allocated'
          : 'Overpayment held as credit'
      });
      applied.push({ allocation_id: surplusRow.allocation_id, amount: remaining });
      remaining = 0;
    }

    var payment = appendRow('BudgetPayments', {
      payment_date: date,
      category_key: keys.join(','),
      category: label,
      scope: getCategoryDef(keys[0]).scope,
      amount: round2(payAmount - remaining),
      notes: notes || '',
      covered: formatCoveredAllocations(applied),
      created_date: todayLocal()
    });

    return {
      payment_id: payment.payment_id,
      amount: payment.amount,
      category: label,
      allocations: applied.length,
      surplus: surplus,
      surplusMode: surplus > 0 ? mode : null
    };
  });
}

/**
 * What to do when a payment comes to more than was outstanding.
 *
 *   refuse  — the default, and what every caller got before this existed
 *   overpay — you paid more than you owed; hold the extra as credit
 *   correct — you owed more than was allocated; raise what is owed to match
 */
var SURPLUS_REFUSE = 'refuse';
var SURPLUS_OVERPAY = 'overpay';
var SURPLUS_CORRECT = 'correct';

/**
 * Which invoice a surplus row belongs to.
 *
 * It belongs to no invoice really — it is a fact about the bucket. But every
 * figure on the page is filtered by its invoice's date, so a row with no
 * invoice would vanish the moment a date filter was applied, taking the credit
 * with it. The most recent invoice the bucket touched inside the range is the
 * period the payment was for, so the surplus is filed there.
 */
function bucketAnchorInvoice(keys, params, eligible) {
  var wanted = {};
  keys.forEach(function(k) { wanted[k] = true; });

  var invoices = getByDateParams('Invoices', 'created_date', params);
  var isFiltered = isFilteringParams(params);
  var invDate = {};
  invoices.forEach(function(inv) {
    invDate[normalizeId(inv.invoice_id)] = dateOnly(inv.created_date) || '';
  });

  var candidates = (eligible && eligible.length ? eligible : getAll('BudgetAllocations'))
    .filter(function(a) {
      if (!wanted[resolveCategoryKey(a)]) return false;
      return !isFiltered || invDate[normalizeId(a.invoice_id)] !== undefined;
    });

  if (candidates.length === 0) {
    throw new Error('Nothing has been allocated to this bucket in this date range, ' +
      'so there is nothing to hold a payment against. Allocate an invoice first.');
  }

  candidates.sort(function(a, b) {
    var da = invDate[normalizeId(a.invoice_id)] || '';
    var db = invDate[normalizeId(b.invoice_id)] || '';
    if (da !== db) return da < db ? 1 : -1;
    return String(a.allocation_id) < String(b.allocation_id) ? 1 : -1;
  });
  return candidates[0].invoice_id;
}

/**
 * Allocations a payment for these categories may be applied to: still owed,
 * inside the page's date range, oldest invoice first.
 *
 * Ordered by the invoice date rather than the allocation id so a back-dated
 * invoice allocated late is still paid in the order the work was billed.
 * Allocation id breaks ties, which keeps the order stable.
 */
function eligibleAllocations(keys, params) {
  var wanted = {};
  keys.forEach(function(k) { wanted[k] = true; });

  var invoices = getByDateParams('Invoices', 'created_date', params);
  var isFiltered = isFilteringParams(params);

  var invDate = {};
  invoices.forEach(function(inv) {
    invDate[normalizeId(inv.invoice_id)] = dateOnly(inv.created_date) || '';
  });

  return getAll('BudgetAllocations').filter(function(a) {
    if (!wanted[resolveCategoryKey(a)]) return false;
    if (isFiltered && invDate[normalizeId(a.invoice_id)] === undefined) return false;
    return allocationOutstanding(a) > 0;
  }).sort(function(a, b) {
    var da = invDate[normalizeId(a.invoice_id)] || '';
    var db = invDate[normalizeId(b.invoice_id)] || '';
    if (da !== db) return da < db ? -1 : 1;
    return String(a.allocation_id) < String(b.allocation_id) ? -1 : 1;
  });
}

/**
 * Undo a payment: put back exactly what it took from each allocation, then
 * remove the payment row.
 *
 * The allocations are updated before the row is deleted, because deleting a
 * row shifts every `_rowIndex` below it.
 */
function undoBudgetPayment(paymentId) {
  return withScriptLock(function() {
    var payments = budgetPaymentRows();
    var payment = payments.find(function(p) { return idsMatch(p.payment_id, paymentId); });
    if (!payment) throw new Error('Payment not found: ' + paymentId);

    var covered = parseCoveredAllocations(payment.covered);
    var allocs = getAll('BudgetAllocations');
    var surplusRows = [];

    covered.forEach(function(entry) {
      var alloc = allocs.find(function(a) { return idsMatch(a.allocation_id, entry.allocation_id); });
      if (!alloc) return;

      // A correction or a credit exists only because of this payment, so
      // undoing the payment removes it rather than leaving a row that owes
      // nothing and has been paid nothing.
      if (!isCascadeLine(alloc)) {
        surplusRows.push(alloc);
        return;
      }

      var paid = round2(allocationPaidAmount(alloc) - entry.amount);
      alloc.paid_amount = paid > 0 ? paid : 0;
      if (alloc.paid_amount > 0 &&
          Math.abs((Number(alloc.amount) || 0) - alloc.paid_amount) < 0.005) {
        alloc.status = 'paid';
      } else {
        alloc.status = 'allocated';
        alloc.transfer_date = '';
      }
      updateRow('BudgetAllocations', alloc._rowIndex, alloc);
    });

    // Descending, so deleting one never shifts another still to be deleted.
    surplusRows.sort(function(a, b) { return b._rowIndex - a._rowIndex; })
      .forEach(function(a) { deleteRow('BudgetAllocations', a._rowIndex); });

    deleteRow('BudgetPayments', payment._rowIndex);

    return { success: true, amount: Number(payment.amount) || 0, category: payment.category };
  });
}

/**
 * Remove an invoice's budget allocations, so it can be re-allocated or voided.
 *
 * Until this existed, voiding an allocated invoice told the user to "remove
 * them first" and there was no way to do that — a correction to an allocated
 * invoice meant editing the spreadsheet by hand.
 *
 * Refused while any recorded payment touches those allocations: deleting them
 * would leave a payment pointing at rows that no longer exist, and its Undo
 * would then silently do nothing. The payments are named so they can be undone
 * from the History section first.
 */
function deallocateInvoice(invoiceId) {
  return withScriptLock(function() {
    var invoice = findById('Invoices', invoiceId);
    if (!invoice) throw new Error('Invoice not found: ' + invoiceId);

    var allocations = getAll('BudgetAllocations').filter(function(a) {
      return idsMatch(a.invoice_id, invoiceId);
    });
    if (allocations.length === 0) {
      throw new Error('This invoice has no budget allocations to remove.');
    }

    var mine = {};
    allocations.forEach(function(a) { mine[normalizeId(a.allocation_id)] = true; });

    var blocking = budgetPaymentRows().filter(function(p) {
      return parseCoveredAllocations(p.covered).some(function(c) {
        return !!mine[normalizeId(c.allocation_id)];
      });
    });

    if (blocking.length > 0) {
      var named = blocking.slice(0, 3).map(function(p) {
        return formatMoneyPlain(p.amount) + ' on ' + (dateOnly(p.payment_date) || 'an unknown date') +
          ' (' + (p.category || 'unknown') + ')';
      }).join('; ');
      throw new Error('Cannot remove — ' + blocking.length + ' payment' +
        (blocking.length === 1 ? '' : 's') + ' already settled part of this allocation: ' + named +
        (blocking.length > 3 ? '; and more' : '') +
        '. Undo them under Budget > Money Flow > History, then try again.');
    }

    // Descending, so deleting a row never shifts one still to be deleted.
    allocations.sort(function(a, b) { return b._rowIndex - a._rowIndex; })
      .forEach(function(a) { deleteRow('BudgetAllocations', a._rowIndex); });

    // The invoice no longer follows any rule, so the Allocate tab offers it
    // again rather than showing it as already done.
    invoice.budget_rule_id = '';
    updateRow('Invoices', invoice._rowIndex, invoice);

    return { success: true, removed: allocations.length, invoice_id: invoice.invoice_id };
  });
}

/** Plain money for an error message — no Utilities, no locale surprises. */
function formatMoneyPlain(amount) {
  return '$' + (Math.round((Number(amount) || 0) * 100) / 100).toFixed(2);
}

/**
 * Everything the Allocate tab needs, in one round trip.
 *
 * It used to take three: every paid invoice with its details, the whole
 * BudgetAllocations sheet, and every budget rule — with the matching done in
 * the browser. Three executions to start, and the entire allocations sheet
 * crossing the bridge to answer one question: which invoices are not on it.
 * Only the four fields the form renders come back now.
 *
 * No date window, deliberately. A paid invoice with no budget behind it is a
 * to-do, not a period figure — the same reason the Dashboard's count ignores
 * the filter. A window here could hide one from this tab while the Dashboard
 * went on saying three were waiting.
 */
function getBudgetAllocateView() {
  return withSheetCache(function() {
    var allocated = {};
    getAll('BudgetAllocations').forEach(function(a) {
      allocated[normalizeId(a.invoice_id)] = true;
    });

    var invoices = getInvoicesWithDetails({}).filter(function(inv) {
      return inv.status === 'paid' && !allocated[normalizeId(inv.invoice_id)];
    }).map(function(inv) {
      return {
        invoice_id: inv.invoice_id,
        business_name: inv.business_name,
        total: Number(inv.total) || 0,
        currency: inv.currency || 'NZD'
      };
    });

    // A blank `active` is a rule written before the column existed, not an
    // inactive one — same reading as the Settings page.
    var rules = getBudgetRules().filter(function(r) {
      return isTruthy(r.active) || r.active === '' ||
        r.active === undefined || r.active === null;
    });

    // Pre-company rules are not offered at all. They are kept so historical
    // allocations still read, but the cascade behind them is frozen, so an
    // option that could only ever be refused is not an option. The count comes
    // back so the empty state can say why there is nothing to choose.
    var companyRules = rules.filter(function(r) { return ruleModel(r) === MODEL_COMPANY; });

    return {
      invoices: invoices,
      rules: companyRules.map(function(r) {
        return { rule_id: r.rule_id, name: r.name, is_default: isTruthy(r.is_default) };
      }),
      ruleCount: rules.length,
      frozenCount: rules.length - companyRules.length
    };
  });
}

/**
 * Get budget summary across all invoices, grouped by scope.
 *
 * Owner Pay is reported separately as `bridge` and excluded from every money
 * total — it is a transfer between two of your own accounts, so counting it
 * would double every personal dollar.
 */
function getBudgetSummary(params) {
  // One block for the whole summary: Invoices, BudgetAllocations, Businesses,
  // BudgetPayments and BusinessExpenses are each read once instead of once per
  // helper that wants them.
  return withSheetCache(function() { return buildBudgetSummary(params); });
}

function buildBudgetSummary(params) {
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

  // Allocation ids in range, so the payment history can be narrowed to the
  // same window the figures above it describe.
  var inRangeAllocations = {};

  allocations.forEach(function(a) {
    var key = resolveCategoryKey(a);
    var cat = byKey[key];
    if (!cat) return;

    var amount = Number(a.amount) || 0;
    var paid = allocationPaidAmount(a);
    var outstanding = round2(amount - paid);
    var inv = invMap[normalizeId(a.invoice_id)] || {};

    inRangeAllocations[normalizeId(a.allocation_id)] = true;

    cat.allocated += amount;
    cat.paid += paid;
    cat.outstanding += outstanding;

    var entryType = allocationEntryType(a);
    cat.items.push({
      allocation_id: a.allocation_id,
      invoice_id: a.invoice_id,
      business_name: bizMap[normalizeId(inv.business_id)] || 'Unknown',
      amount: amount,
      paid: paid,
      outstanding: outstanding,
      entry_type: entryType,
      // 'part-paid' is display only: the stored status stays allocated/paid.
      status: entryType === ENTRY_CREDIT ? 'credit'
        : entryType === ENTRY_ADJUSTMENT ? 'correction'
        : outstanding <= 0.004 ? 'paid' : (paid > 0 ? 'part-paid' : 'allocated'),
      transfer_date: a.transfer_date || '',
      notes: a.notes || ''
    });
  });

  // Floating-point dust from summing rounded halves of percentages: without
  // this a fully paid bucket can report $0.00 outstanding as 2.8e-14 and
  // render an action button for money that is not owed.
  Object.keys(byKey).forEach(function(k) {
    byKey[k].allocated = round2(byKey[k].allocated);
    byKey[k].paid = round2(byKey[k].paid);
    byKey[k].outstanding = round2(byKey[k].outstanding);
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
    totals: totals,
    payments: budgetPaymentHistory(inRangeAllocations, isFiltered),
    // What has been spent OUT of each pot (BusinessExpenseService). Reported
    // alongside rather than folded in: an operating cost is not an allocation,
    // and every identity above it is about money being assigned, not spent.
    potSpending: potSpending(params)
  };
}

/**
 * The payment history for the current view, newest first.
 *
 * A payment belongs to the view when any allocation it settled is in range —
 * paying a category settles allocations, and it is those that carry the date.
 */
function budgetPaymentHistory(inRangeAllocations, isFiltered) {
  return budgetPaymentRows().filter(function(p) {
    if (!isFiltered) return true;
    return parseCoveredAllocations(p.covered).some(function(c) {
      return !!inRangeAllocations[normalizeId(c.allocation_id)];
    });
  }).map(function(p) {
    var covered = parseCoveredAllocations(p.covered);
    return {
      payment_id: p.payment_id,
      payment_date: dateOnly(p.payment_date) || '',
      category: p.category || '',
      category_key: p.category_key || '',
      scope: p.scope || '',
      amount: Number(p.amount) || 0,
      notes: p.notes || '',
      allocations: covered.length
    };
  }).sort(function(a, b) {
    if (a.payment_date !== b.payment_date) return a.payment_date < b.payment_date ? 1 : -1;
    return String(a.payment_id) < String(b.payment_id) ? 1 : -1;
  });
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

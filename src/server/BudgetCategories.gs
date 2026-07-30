/**
 * Budget category registry — the single source of truth for every bucket.
 *
 * Money is split across two scopes joined by a derived bridge:
 *
 *   BUSINESS (company money, stays in the business account)
 *     gross            = invoice time_subtotal (ex-GST, billed hours only)
 *     withheld         = % of gross deducted at source (usually 0% for a company)
 *     business income  = gross - withheld
 *     GST              = taken verbatim from the invoice, not a percentage
 *     Business Tax / Business ACC / Reserve = % of business income
 *
 *   BRIDGE
 *     Owner Pay        = business income - (Business Tax + Business ACC + Reserve)
 *                        An exact remainder, so it never drifts by a cent.
 *                        Excluded from money totals — it is a transfer between
 *                        two of your own accounts, not a new dollar.
 *
 *   PERSONAL (drawn money, in the personal account)
 *     Personal Tax / Personal ACC = % of Owner Pay
 *     personal net     = Owner Pay - (Personal Tax + Personal ACC)
 *     Donate / Save / Invest / Spend = % of personal net, must sum to 100%.
 *                        Rounding residual lands on Spend so the lines sum exactly.
 *
 * Conservation invariant, asserted by tools/check-budget-math.js:
 *   sum of all non-transfer lines === gross + gst
 *
 * This file deliberately references no Google globals (no SpreadsheetApp,
 * LockService or HtmlService) so the cascade maths can be exercised outside
 * Apps Script — it is the only testable seam in the codebase.
 *
 * Percentages are stored as decimals (0.28 = 28%).
 */

var BUDGET_SCOPES = [
  { scope: 'business', label: 'Business', accountHint: 'business account' },
  { scope: 'bridge', label: 'Owner Pay', accountHint: '' },
  { scope: 'personal', label: 'Personal', accountHint: 'personal account' },
  { scope: 'legacy', label: 'Legacy (sole trader)', accountHint: '' }
];

/**
 * Settlement mode drives the wording of the action button in the UI. All four
 * still map onto the same two-state stored model (allocated -> paid):
 *   auto_paid — created already settled (payer withheld it at source)
 *   pay       — leaves your accounts entirely ("Mark Paid")
 *   hold      — stays where it is ("Mark Set Aside")
 *   transfer  — moves between your own accounts ("Mark Transferred")
 */
var BUDGET_CATEGORY_DEFS = [
  { key: 'biz_tax_withheld', label: 'Tax Withheld', scope: 'business', group: 'withholding',
    basis: 'gross', pctField: 'biz_tax_withheld_pct', settle: 'auto_paid', defaultPct: 0 },
  { key: 'biz_acc_withheld', label: 'ACC Withheld', scope: 'business', group: 'withholding',
    basis: 'gross', pctField: 'biz_acc_withheld_pct', settle: 'auto_paid', defaultPct: 0 },

  { key: 'biz_gst', label: 'GST', scope: 'business', group: 'business',
    basis: 'invoice_gst', pctField: null, settle: 'pay', defaultPct: null },
  { key: 'biz_tax', label: 'Business Tax', scope: 'business', group: 'business',
    basis: 'business_income', pctField: 'biz_tax_pct', settle: 'pay', defaultPct: 0.28 },
  { key: 'biz_acc', label: 'Business ACC', scope: 'business', group: 'business',
    basis: 'business_income', pctField: 'biz_acc_pct', settle: 'pay', defaultPct: 0.01 },
  { key: 'biz_reserve', label: 'Reserve', scope: 'business', group: 'business',
    basis: 'business_income', pctField: 'biz_reserve_pct', settle: 'hold', defaultPct: 0.10 },

  { key: 'owner_pay', label: 'Owner Pay', scope: 'bridge', group: 'bridge',
    basis: 'remainder', pctField: null, settle: 'transfer', defaultPct: null, isTransfer: true },

  { key: 'per_tax', label: 'Personal Tax', scope: 'personal', group: 'personal_obligation',
    basis: 'owner_pay', pctField: 'per_tax_pct', settle: 'pay', defaultPct: 0.30 },
  { key: 'per_acc', label: 'Personal ACC', scope: 'personal', group: 'personal_obligation',
    basis: 'owner_pay', pctField: 'per_acc_pct', settle: 'pay', defaultPct: 0.0167 },

  { key: 'per_donate', label: 'Donate', scope: 'personal', group: 'personal_distribution',
    basis: 'personal_net', pctField: 'per_donate_pct', settle: 'pay', defaultPct: 0.05 },
  { key: 'per_save', label: 'Save', scope: 'personal', group: 'personal_distribution',
    basis: 'personal_net', pctField: 'per_save_pct', settle: 'hold', defaultPct: 0.10 },
  { key: 'per_invest', label: 'Invest', scope: 'personal', group: 'personal_distribution',
    basis: 'personal_net', pctField: 'per_invest_pct', settle: 'hold', defaultPct: 0.15 },
  { key: 'per_spend', label: 'Spend', scope: 'personal', group: 'personal_distribution',
    basis: 'personal_net', pctField: 'per_spend_pct', settle: 'transfer', defaultPct: 0.70 }
];

/** The distribution bucket that absorbs the rounding residual. */
var PERSONAL_RESIDUAL_KEY = 'per_spend';

/**
 * The pre-company sole-trader buckets. Kept so historical allocations still
 * render and so a legacy rule can still be applied if an old invoice needs
 * allocating. Order matters: the derived arrays below are index-aligned to it,
 * exactly as the original hardcoded constants were.
 */
var LEGACY_CATEGORY_DEFS = [
  { key: 'legacy_tax_withheld', label: 'Tax Withheld', scope: 'legacy', group: 'withheld',
    basis: 'gross', pctField: 'tax_withheld_pct', settle: 'auto_paid', defaultPct: 0 },
  { key: 'legacy_tax', label: 'Tax To Pay', scope: 'legacy', group: 'obligation',
    basis: 'adjusted', pctField: 'tax_to_pay_pct', settle: 'pay', defaultPct: 0.28 },
  { key: 'legacy_acc_withheld', label: 'ACC Withheld', scope: 'legacy', group: 'withheld',
    basis: 'gross', pctField: 'acc_withheld_pct', settle: 'auto_paid', defaultPct: 0 },
  { key: 'legacy_acc', label: 'ACC To Pay', scope: 'legacy', group: 'obligation',
    basis: 'adjusted', pctField: 'acc_to_pay_pct', settle: 'pay', defaultPct: 0.02 },
  { key: 'legacy_gst', label: 'GST Collected', scope: 'legacy', group: 'obligation',
    basis: 'invoice_gst', pctField: null, settle: 'pay', defaultPct: null },
  { key: 'legacy_donate', label: 'Donate', scope: 'legacy', group: 'distribution',
    basis: 'net', pctField: 'donate_pct', settle: 'pay', defaultPct: 0.05 },
  { key: 'legacy_save', label: 'Save', scope: 'legacy', group: 'distribution',
    basis: 'net', pctField: 'save_pct', settle: 'hold', defaultPct: 0.10 },
  { key: 'legacy_invest', label: 'Invest', scope: 'legacy', group: 'distribution',
    basis: 'net', pctField: 'invest_pct', settle: 'hold', defaultPct: 0.15 },
  { key: 'legacy_spend', label: 'Spend', scope: 'legacy', group: 'distribution',
    basis: 'net', pctField: 'spend_pct', settle: 'transfer', defaultPct: 0.70 }
];

// Index-aligned arrays the sole-trader cascade still runs on. Derived here
// rather than hardcoded so the two can never drift apart.
var BUDGET_CATEGORIES = LEGACY_CATEGORY_DEFS.map(function(d) { return d.label; });
var BUDGET_PCT_FIELDS = LEGACY_CATEGORY_DEFS.map(function(d) { return d.pctField; });
var WITHHELD_CATEGORIES = legacyLabelsInGroup('withheld');
var OBLIGATION_CATEGORIES = legacyLabelsInGroup('obligation');
var DISTRIBUTION_CATEGORIES = legacyLabelsInGroup('distribution');

/**
 * Historical BudgetAllocations rows store only the free-text label. Map those
 * labels onto legacy keys so they can be told apart from the new personal
 * buckets, which reuse 'Donate' / 'Save' / 'Invest' / 'Spend'.
 */
var LEGACY_LABEL_TO_KEY = (function() {
  var map = {};
  LEGACY_CATEGORY_DEFS.forEach(function(d) { map[d.label] = d.key; });
  return map;
})();

var COMPANY_LABEL_TO_KEY = (function() {
  var map = {};
  BUDGET_CATEGORY_DEFS.forEach(function(d) { map[d.label] = d.key; });
  return map;
})();

/**
 * Labels that only a company allocation can carry. Six labels are shared with
 * the legacy set (Donate, Save, Invest, Spend, Tax Withheld, ACC Withheld), so
 * a single row is ambiguous — but these are not, which lets a whole invoice's
 * allocation set be classified with certainty. See migrateBudgetAllocations.
 */
var COMPANY_ONLY_LABELS = (function() {
  var legacyLabels = LEGACY_CATEGORY_DEFS.map(function(d) { return d.label; });
  return BUDGET_CATEGORY_DEFS.map(function(d) { return d.label; })
    .filter(function(label) { return legacyLabels.indexOf(label) === -1; });
})();

function isCompanyOnlyLabel(label) {
  return COMPANY_ONLY_LABELS.indexOf(String(label)) !== -1;
}

/**
 * How each settlement mode is described and actioned. Kept here so the server
 * and the UI cannot drift apart on the wording.
 */
var SETTLE_MODES = {
  auto_paid: { key: 'auto_paid', groupLabel: 'Withheld at source', verb: '', settledWord: 'withheld' },
  pay: { key: 'pay', groupLabel: 'Owed out', verb: 'Mark Paid', settledWord: 'paid' },
  hold: { key: 'hold', groupLabel: 'Held back', verb: 'Mark Set Aside', settledWord: 'set aside' },
  transfer: { key: 'transfer', groupLabel: 'To transfer', verb: 'Mark Transferred', settledWord: 'transferred' }
};

/** Order the settle groups are presented in within a pot. */
var SETTLE_GROUP_ORDER = ['pay', 'hold', 'transfer', 'auto_paid'];

var MODEL_COMPANY = 'company';
var MODEL_SOLE_TRADER = 'sole_trader';

// --- Registry helpers ---

function legacyLabelsInGroup(group) {
  return LEGACY_CATEGORY_DEFS.filter(function(d) {
    return d.group === group;
  }).map(function(d) { return d.label; });
}

function companyDefsInGroup(group) {
  return BUDGET_CATEGORY_DEFS.filter(function(d) { return d.group === group; });
}

function allCategoryDefs() {
  return BUDGET_CATEGORY_DEFS.concat(LEGACY_CATEGORY_DEFS);
}

function getCategoryDef(key) {
  var all = allCategoryDefs();
  for (var i = 0; i < all.length; i++) {
    if (all[i].key === key) return all[i];
  }
  return null;
}

/**
 * The percentage fields a rule of the given model owns.
 */
function pctFieldsForModel(model) {
  var defs = (model === MODEL_SOLE_TRADER) ? LEGACY_CATEGORY_DEFS : BUDGET_CATEGORY_DEFS;
  return defs.filter(function(d) { return !!d.pctField; })
    .map(function(d) { return d.pctField; });
}

/**
 * Which cascade a rule's percentages belong to.
 *
 * A stored model wins. Failing that, a rule that predates the company split is
 * identified by having actual legacy percentages: validateLegacyBudgetRule
 * forces its distribution to sum to 100%, so a genuine sole-trader rule always
 * has non-blank legacy fields. A rule with neither a model nor any legacy
 * percentage was written by the company form onto a sheet that had no `model`
 * column yet, so treat it as company — otherwise it is stranded in the legacy
 * table and cannot be repaired through the UI.
 */
function ruleModel(rule) {
  var stored = String((rule && rule.model) || '');
  if (stored === MODEL_COMPANY) return MODEL_COMPANY;
  if (stored === MODEL_SOLE_TRADER) return MODEL_SOLE_TRADER;
  return hasLegacyPercentages(rule) ? MODEL_SOLE_TRADER : MODEL_COMPANY;
}

function hasLegacyPercentages(rule) {
  if (!rule) return false;
  return LEGACY_CATEGORY_DEFS.some(function(d) {
    if (!d.pctField) return false;
    return (Number(rule[d.pctField]) || 0) !== 0;
  });
}

/**
 * Resolve an allocation row to a category key. New rows carry category_key;
 * rows written before the company split carry only the old label.
 */
function resolveCategoryKey(alloc) {
  if (!alloc) return '';
  if (alloc.category_key !== undefined && alloc.category_key !== null && alloc.category_key !== '') {
    return String(alloc.category_key);
  }
  return LEGACY_LABEL_TO_KEY[String(alloc.category)] || '';
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function rulePct(rule, def) {
  if (!def.pctField) return 0;
  return Number(rule[def.pctField]) || 0;
}

function sumGroupPct(rule, group) {
  return companyDefsInGroup(group).reduce(function(sum, d) {
    return sum + rulePct(rule, d);
  }, 0);
}

function groupLabels(group) {
  return companyDefsInGroup(group).filter(function(d) {
    return !!d.pctField;
  }).map(function(d) { return d.label; }).join(', ');
}

// --- Company cascade ---

/**
 * Compute every allocation line for a company rule.
 *
 * @param {Object} rule - a BudgetRules row (percentages as decimals)
 * @param {number} gross - invoice time_subtotal, ex-GST
 * @param {number} gstAmount - invoice gst_amount, or 0 when not GST-inclusive
 * @return {{lines: Array, stages: Object, total: number}}
 */
function computeCompanyAllocation(rule, gross, gstAmount) {
  gross = round2(gross);
  gstAmount = round2(gstAmount);

  var amounts = {};

  // Withholding, off gross. Cash never arrived, so it is settled on creation.
  var withheld = 0;
  companyDefsInGroup('withholding').forEach(function(d) {
    var amt = round2(gross * rulePct(rule, d));
    amounts[d.key] = amt;
    withheld += amt;
  });
  withheld = round2(withheld);

  var businessIncome = round2(gross - withheld);

  // Business buckets, off business income. GST sits outside the cascade —
  // it was never income, it is the tax office's money passing through.
  var businessObligations = 0;
  companyDefsInGroup('business').forEach(function(d) {
    if (d.basis === 'invoice_gst') {
      amounts[d.key] = gstAmount;
      return;
    }
    var amt = round2(businessIncome * rulePct(rule, d));
    amounts[d.key] = amt;
    businessObligations += amt;
  });
  businessObligations = round2(businessObligations);

  // The bridge: an exact remainder, so business and personal always reconcile.
  var ownerPay = round2(businessIncome - businessObligations);
  amounts.owner_pay = ownerPay;

  var personalObligations = 0;
  companyDefsInGroup('personal_obligation').forEach(function(d) {
    var amt = round2(ownerPay * rulePct(rule, d));
    amounts[d.key] = amt;
    personalObligations += amt;
  });
  personalObligations = round2(personalObligations);

  var personalNet = round2(ownerPay - personalObligations);

  // Distribution, off personal net. Every bucket but the residual one is a
  // straight percentage; the residual absorbs the rounding difference so the
  // lines sum to personal net exactly.
  var distributed = 0;
  companyDefsInGroup('personal_distribution').forEach(function(d) {
    if (d.key === PERSONAL_RESIDUAL_KEY) return;
    var amt = round2(personalNet * rulePct(rule, d));
    amounts[d.key] = amt;
    distributed += amt;
  });
  amounts[PERSONAL_RESIDUAL_KEY] = round2(personalNet - round2(distributed));

  var lines = BUDGET_CATEGORY_DEFS.map(function(d) {
    return {
      key: d.key,
      label: d.label,
      scope: d.scope,
      group: d.group,
      basis: d.basis,
      settle: d.settle,
      isTransfer: !!d.isTransfer,
      pct: d.pctField ? rulePct(rule, d) : null,
      amount: amounts[d.key] || 0
    };
  });

  var total = round2(lines.reduce(function(sum, l) {
    return l.isTransfer ? sum : sum + l.amount;
  }, 0));

  return {
    lines: lines,
    stages: {
      gross: gross,
      withheld: withheld,
      businessIncome: businessIncome,
      gst: gstAmount,
      businessObligations: businessObligations,
      ownerPay: ownerPay,
      personalObligations: personalObligations,
      personalNet: personalNet
    },
    total: total
  };
}

/**
 * Validate a company rule. Percentages within a stage may not consume more
 * than that stage's base, and the personal distribution must be exactly 100%.
 */
function validateCompanyRule(rule) {
  var withholding = sumGroupPct(rule, 'withholding');
  if (withholding > 1.000001) {
    throw new Error('Withholding (' + groupLabels('withholding') + ') cannot exceed 100% of gross. Current: ' +
      (withholding * 100).toFixed(1) + '%');
  }

  var business = sumGroupPct(rule, 'business');
  if (business > 1.000001) {
    throw new Error('Business allocations (' + groupLabels('business') + ') cannot exceed 100% of business income — ' +
      'that would leave a negative Owner Pay. Current: ' + (business * 100).toFixed(1) + '%');
  }

  var personalObligation = sumGroupPct(rule, 'personal_obligation');
  if (personalObligation > 1.000001) {
    throw new Error('Personal obligations (' + groupLabels('personal_obligation') + ') cannot exceed 100% of Owner Pay. Current: ' +
      (personalObligation * 100).toFixed(1) + '%');
  }

  var distribution = sumGroupPct(rule, 'personal_distribution');
  if (Math.abs(distribution - 1.0) > 0.001) {
    throw new Error('Personal distribution (' + groupLabels('personal_distribution') + ') must sum to 100%. Current: ' +
      (distribution * 100).toFixed(1) + '%');
  }

  return true;
}

/**
 * Client-callable: hand the registry to the front end so it stops keeping its
 * own copies of the category list.
 */
function getBudgetCategories() {
  return {
    scopes: BUDGET_SCOPES,
    categories: BUDGET_CATEGORY_DEFS,
    legacy: LEGACY_CATEGORY_DEFS,
    residualKey: PERSONAL_RESIDUAL_KEY,
    settleModes: SETTLE_MODES,
    settleGroupOrder: SETTLE_GROUP_ORDER,
    models: { company: MODEL_COMPANY, soleTrader: MODEL_SOLE_TRADER }
  };
}

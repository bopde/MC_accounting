#!/usr/bin/env node
/**
 * Dependency-free checks for the budget cascade.
 *
 *   node tools/check-budget-math.js
 *
 * The app itself only runs inside Google Apps Script, but the cascade maths in
 * src/server/BudgetCategories.gs deliberately references no Google globals, so
 * it can be loaded and exercised here. This is the only automated safety net
 * for the allocation engine — run it before pushing changes to either
 * BudgetCategories.gs or BudgetService.gs.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const FILES = ['BudgetCategories.gs', 'BudgetService.gs'];

const source = FILES
  .map(function(f) { return fs.readFileSync(path.join(ROOT, 'src', 'server', f), 'utf8'); })
  .join('\n');

// Only the pure functions are called, so a stub Logger is the whole shim needed.
const app = { Logger: { log: function() {} } };
vm.createContext(app);
vm.runInContext(source, app, { filename: 'budget-cascade.js' });

// --- Test harness ---

let failures = 0;
let passes = 0;

function check(name, fn) {
  try {
    fn();
    passes++;
    console.log('  ok    ' + name);
  } catch (e) {
    failures++;
    console.log('  FAIL  ' + name);
    console.log('        ' + e.message);
  }
}

function eq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error((msg ? msg + ': ' : '') + 'expected ' + expected + ', got ' + actual);
  }
}

function throws(fn, fragment) {
  let threw = null;
  try {
    fn();
  } catch (e) {
    threw = e;
  }
  if (!threw) throw new Error('expected a throw, got none');
  if (fragment && threw.message.indexOf(fragment) === -1) {
    throw new Error('expected message containing "' + fragment + '", got "' + threw.message + '"');
  }
}

function section(title) {
  console.log('\n' + title);
}

// --- Fixtures ---

const companyRule = {
  model: 'company',
  biz_tax_withheld_pct: 0,
  biz_acc_withheld_pct: 0,
  biz_tax_pct: 0.28,
  biz_acc_pct: 0.01,
  biz_reserve_pct: 0.10,
  per_tax_pct: 0.30,
  per_acc_pct: 0.0167,
  per_donate_pct: 0.05,
  per_save_pct: 0.10,
  per_invest_pct: 0.15,
  per_spend_pct: 0.70
};

const withholdingRule = Object.assign({}, companyRule, {
  biz_tax_withheld_pct: 0.20,
  biz_acc_withheld_pct: 0.02
});

const legacyRule = {
  tax_withheld_pct: 0.10,
  acc_withheld_pct: 0.02,
  tax_to_pay_pct: 0.28,
  acc_to_pay_pct: 0.02,
  donate_pct: 0.05,
  save_pct: 0.10,
  invest_pct: 0.15,
  spend_pct: 0.70
};

// Awkward figures on purpose: thirds, long decimals, and zero.
const GROSS_CASES = [0, 1, 100, 1000, 3333.33, 4761.91, 12345.67, 99999.99];
const RULES = [
  { name: 'no withholding', rule: companyRule },
  { name: 'with withholding', rule: withholdingRule }
];

function amountOf(plan, key) {
  const line = plan.lines.find(function(l) { return l.key === key; });
  if (!line) throw new Error('no line for key ' + key);
  return line.amount;
}

function sumKeys(plan, keys) {
  return app.round2(keys.reduce(function(s, k) { return s + amountOf(plan, k); }, 0));
}

// --- Conservation: every dollar lands somewhere, exactly once ---

section('Conservation — non-transfer lines sum to gross + GST');
RULES.forEach(function(r) {
  GROSS_CASES.forEach(function(gross) {
    [0, app.round2(gross * 0.15)].forEach(function(gst) {
      check(r.name + ', gross ' + gross + ', gst ' + gst, function() {
        const plan = app.computeCompanyAllocation(r.rule, gross, gst);
        const summed = app.round2(plan.lines.reduce(function(s, l) {
          return l.isTransfer ? s : s + l.amount;
        }, 0));
        eq(summed, app.round2(gross + gst), 'sum of lines');
        eq(plan.total, app.round2(gross + gst), 'reported total');
      });
    });
  });
});

// --- Owner Pay is an exact remainder ---

section('Owner Pay — exact remainder of business income');
RULES.forEach(function(r) {
  GROSS_CASES.forEach(function(gross) {
    check(r.name + ', gross ' + gross, function() {
      const plan = app.computeCompanyAllocation(r.rule, gross, 0);
      const businessBuckets = sumKeys(plan, ['biz_tax', 'biz_acc', 'biz_reserve']);
      eq(amountOf(plan, 'owner_pay'),
        app.round2(plan.stages.businessIncome - businessBuckets), 'owner pay');
      eq(plan.stages.businessIncome,
        app.round2(gross - plan.stages.withheld), 'business income');
    });
  });
});

// --- Distribution lines sum to personal net exactly ---

section('Distribution — residual keeps the four buckets exact');
RULES.forEach(function(r) {
  GROSS_CASES.forEach(function(gross) {
    check(r.name + ', gross ' + gross, function() {
      const plan = app.computeCompanyAllocation(r.rule, gross, 0);
      const dist = sumKeys(plan, ['per_donate', 'per_save', 'per_invest', 'per_spend']);
      eq(dist, plan.stages.personalNet, 'distribution total');
      const obligations = sumKeys(plan, ['per_tax', 'per_acc']);
      eq(plan.stages.personalNet,
        app.round2(amountOf(plan, 'owner_pay') - obligations), 'personal net');
    });
  });
});

// A case where the naive per-line rounding would drift: personal net of
// 1234.57 split 5/10/15/70 gives .2285 / .457 / .6855 / 3.199 fractions.
section('Distribution — residual absorbs the rounding difference');
check('gross 2050.13 lines sum to personal net', function() {
  const plan = app.computeCompanyAllocation(companyRule, 2050.13, 0);
  const dist = sumKeys(plan, ['per_donate', 'per_save', 'per_invest', 'per_spend']);
  eq(dist, plan.stages.personalNet, 'distribution total');
});

// --- GST sits outside the cascade ---

section('GST — taken verbatim, never scaled');
check('gst line equals the invoice gst', function() {
  const plan = app.computeCompanyAllocation(companyRule, 1000, 150);
  eq(amountOf(plan, 'biz_gst'), 150, 'gst line');
  eq(plan.stages.businessIncome, 1000, 'business income ignores gst');
});

// --- Validation ---

section('Validation — company rules');
check('valid rule passes', function() {
  eq(app.validateCompanyRule(companyRule), true, 'validate');
});
check('distribution below 100% throws', function() {
  throws(function() {
    app.validateCompanyRule(Object.assign({}, companyRule, { per_spend_pct: 0.60 }));
  }, 'must sum to 100%');
});
check('distribution above 100% throws', function() {
  throws(function() {
    app.validateCompanyRule(Object.assign({}, companyRule, { per_spend_pct: 0.80 }));
  }, 'must sum to 100%');
});
check('business allocations above 100% throw', function() {
  throws(function() {
    app.validateCompanyRule(Object.assign({}, companyRule, { biz_reserve_pct: 0.80 }));
  }, 'negative Owner Pay');
});
check('personal obligations above 100% throw', function() {
  throws(function() {
    app.validateCompanyRule(Object.assign({}, companyRule, { per_tax_pct: 0.99, per_acc_pct: 0.05 }));
  }, 'cannot exceed 100% of Owner Pay');
});
check('withholding above 100% throws', function() {
  throws(function() {
    app.validateCompanyRule(Object.assign({}, companyRule, { biz_tax_withheld_pct: 1.5 }));
  }, 'cannot exceed 100% of gross');
});
check('exactly 100% business allocation is allowed (zero Owner Pay)', function() {
  const rule = Object.assign({}, companyRule, {
    biz_tax_pct: 0.28, biz_acc_pct: 0.02, biz_reserve_pct: 0.70
  });
  eq(app.validateCompanyRule(rule), true, 'validate');
  const plan = app.computeCompanyAllocation(rule, 1000, 0);
  eq(amountOf(plan, 'owner_pay'), 0, 'owner pay');
  eq(amountOf(plan, 'per_spend'), 0, 'spend');
});

// --- Legacy parity: the sole-trader cascade must be untouched ---

section('Legacy parity — sole-trader cascade unchanged');
check('derived category list matches the original constants', function() {
  eq(app.BUDGET_CATEGORIES.join('|'),
    ['Tax Withheld', 'Tax To Pay', 'ACC Withheld', 'ACC To Pay', 'GST Collected',
      'Donate', 'Save', 'Invest', 'Spend'].join('|'), 'BUDGET_CATEGORIES');
  eq(app.BUDGET_PCT_FIELDS.join('|'),
    ['tax_withheld_pct', 'tax_to_pay_pct', 'acc_withheld_pct', 'acc_to_pay_pct',
      '', 'donate_pct', 'save_pct', 'invest_pct', 'spend_pct'].join('|'), 'BUDGET_PCT_FIELDS');
  eq(app.WITHHELD_CATEGORIES.join('|'), 'Tax Withheld|ACC Withheld', 'WITHHELD_CATEGORIES');
  eq(app.OBLIGATION_CATEGORIES.join('|'), 'Tax To Pay|ACC To Pay|GST Collected', 'OBLIGATION_CATEGORIES');
  eq(app.DISTRIBUTION_CATEGORIES.join('|'), 'Donate|Save|Invest|Spend', 'DISTRIBUTION_CATEGORIES');
});

check('computeAllocationAmounts matches the pre-refactor figures', function() {
  const calc = app.computeAllocationAmounts(legacyRule, 1000);
  eq(calc.withheld, 120, 'withheld');
  eq(calc.adjusted, 880, 'adjusted');
  eq(calc.obligations, 264, 'obligations');
  eq(calc.net, 616, 'net');
  eq(calc.amounts['Tax Withheld'], 100, 'Tax Withheld');
  eq(calc.amounts['ACC Withheld'], 20, 'ACC Withheld');
  eq(calc.amounts['Tax To Pay'], 246.4, 'Tax To Pay');
  eq(calc.amounts['ACC To Pay'], 17.6, 'ACC To Pay');
  eq(calc.amounts['GST Collected'], 0, 'GST Collected');
  eq(calc.amounts['Donate'], 30.8, 'Donate');
  eq(calc.amounts['Save'], 61.6, 'Save');
  eq(calc.amounts['Invest'], 92.4, 'Invest');
  eq(calc.amounts['Spend'], 431.2, 'Spend');
});

check('legacy plan shape matches the company plan shape', function() {
  const plan = app.computeLegacyAllocation(legacyRule, 1000, 150);
  eq(plan.lines.length, 9, 'line count');
  eq(plan.lines[0].scope, 'legacy', 'scope');
  eq(plan.lines.find(function(l) { return l.key === 'legacy_gst'; }).amount, 150, 'gst line');
  eq(plan.total, 1150, 'total');
});

check('legacy validation still only checks the distribution', function() {
  eq(app.validateBudgetRule(legacyRule), true, 'valid legacy rule');
  throws(function() {
    app.validateBudgetRule(Object.assign({}, legacyRule, { spend_pct: 0.5 }));
  }, 'must sum to 100%');
});

// --- Registry integrity ---

section('Registry integrity');
check('every category key is unique', function() {
  const keys = app.allCategoryDefs().map(function(d) { return d.key; });
  eq(keys.length, new Set(keys).size, 'unique keys');
});
check('every percentage field is unique', function() {
  const fields = app.allCategoryDefs()
    .map(function(d) { return d.pctField; })
    .filter(Boolean);
  eq(fields.length, new Set(fields).size, 'unique pct fields');
});
check('exactly one transfer category', function() {
  const transfers = app.BUDGET_CATEGORY_DEFS.filter(function(d) { return d.isTransfer; });
  eq(transfers.length, 1, 'transfer count');
  eq(transfers[0].key, 'owner_pay', 'transfer key');
});
check('the residual key is a distribution bucket', function() {
  const def = app.getCategoryDef(app.PERSONAL_RESIDUAL_KEY);
  eq(!!def, true, 'residual def exists');
  eq(def.group, 'personal_distribution', 'residual group');
});
check('legacy labels map back to legacy keys', function() {
  eq(app.LEGACY_LABEL_TO_KEY['Tax To Pay'], 'legacy_tax', 'Tax To Pay');
  eq(app.LEGACY_LABEL_TO_KEY['Spend'], 'legacy_spend', 'Spend');
  // A row with no category_key is pre-company data, resolved by label.
  eq(app.resolveCategoryKey({ category: 'Spend' }), 'legacy_spend', 'blank key falls back');
  // A row with a key wins, so the new personal Spend is never confused with it.
  eq(app.resolveCategoryKey({ category: 'Spend', category_key: 'per_spend' }), 'per_spend', 'key wins');
});
check('company-only labels exclude the six shared with legacy', function() {
  ['GST', 'Business Tax', 'Business ACC', 'Reserve', 'Owner Pay', 'Personal Tax', 'Personal ACC']
    .forEach(function(label) {
      eq(app.isCompanyOnlyLabel(label), true, label + ' is company-only');
    });
  // These labels are identical in both models, so they can never classify a row.
  ['Donate', 'Save', 'Invest', 'Spend', 'Tax Withheld', 'ACC Withheld']
    .forEach(function(label) {
      eq(app.isCompanyOnlyLabel(label), false, label + ' is ambiguous');
    });
});

check('company labels map to company keys', function() {
  eq(app.COMPANY_LABEL_TO_KEY['Spend'], 'per_spend', 'Spend');
  eq(app.COMPANY_LABEL_TO_KEY['Business Tax'], 'biz_tax', 'Business Tax');
  eq(app.COMPANY_LABEL_TO_KEY['Owner Pay'], 'owner_pay', 'Owner Pay');
  // Same label, different key per model — which is the whole reason
  // migrateBudgetAllocations classifies per invoice rather than per row.
  eq(app.LEGACY_LABEL_TO_KEY['Spend'], 'legacy_spend', 'legacy Spend');
});

check('every settle mode used by a category has metadata', function() {
  app.allCategoryDefs().forEach(function(d) {
    eq(!!app.SETTLE_MODES[d.settle], true, d.key + ' settle "' + d.settle + '"');
  });
  app.SETTLE_GROUP_ORDER.forEach(function(mode) {
    eq(!!app.SETTLE_MODES[mode], true, 'ordered mode ' + mode);
  });
});

section('Rule model inference');
check('an explicit model always wins', function() {
  eq(app.ruleModel({ model: 'company' }), 'company', 'company');
  eq(app.ruleModel({ model: 'sole_trader', tax_to_pay_pct: 0.28 }), 'sole_trader', 'sole trader');
});
check('a real legacy rule with no model column reads as sole trader', function() {
  eq(app.ruleModel(legacyRule), 'sole_trader', 'legacy rule');
});
check('a rule with no model and no legacy percentages reads as company', function() {
  // This is the damaged shape: the company form wrote it to a sheet with no
  // `model` column, so every percentage was dropped and the legacy columns
  // stayed blank. Reading it as legacy would strand it un-editable.
  eq(app.ruleModel({ name: 'Company Default', notes: '' }), 'company', 'blank rule');
  eq(app.ruleModel({ tax_to_pay_pct: '', spend_pct: '' }), 'company', 'blank pct cells');
});
check('a genuine legacy rule can never look blank', function() {
  // validateLegacyBudgetRule forces the distribution to 100%, so at least one
  // legacy percentage is always non-zero — which is what makes the inference safe.
  app.validateLegacyBudgetRule(legacyRule);
  eq(app.hasLegacyPercentages(legacyRule), true, 'has legacy pcts');
});

check('company defaults form a valid rule', function() {
  const seeded = {};
  app.BUDGET_CATEGORY_DEFS.forEach(function(d) {
    if (d.pctField) seeded[d.pctField] = d.defaultPct == null ? 0 : d.defaultPct;
  });
  seeded.model = 'company';
  eq(app.validateCompanyRule(seeded), true, 'seeded defaults valid');
});

// --- Result ---

console.log('\n' + passes + ' passed, ' + failures + ' failed');
process.exit(failures > 0 ? 1 : 0);

/**
 * Settings service for managing reference data:
 * Businesses, WorkCodes, Accounts, BudgetRules, MyDetails
 */

/**
 * Bootstrap: load all reference data in a single RPC.
 */
function bootstrap() {
  var result = {
    businesses: [],
    workCodes: [],
    accounts: [],
    budgetRules: [],
    budgetCategories: null,
    contracts: [],
    myDetails: {},
    schemaWarnings: [],
    errors: []
  };

  // Each section is isolated so one broken sheet cannot blank the whole app —
  // but the reason is reported rather than swallowed, otherwise a missing sheet
  // renders as a cheerful "nothing configured yet".
  function section(name, fn, assign) {
    try {
      assign(fn());
    } catch (e) {
      result.errors.push(name + ': ' + (e && e.message ? e.message : String(e)));
    }
  }

  section('budgetCategories', getBudgetCategories, function(v) { result.budgetCategories = v; });
  section('businesses', function() { return getActive('Businesses'); }, function(v) { result.businesses = v; });
  section('workCodes', function() { return getActive('WorkCodes'); }, function(v) { result.workCodes = v; });
  section('accounts', function() { return getActive('Accounts'); }, function(v) { result.accounts = v; });
  section('budgetRules', function() { return getActiveRules(); }, function(v) { result.budgetRules = v; });
  section('contracts', getActiveContracts, function(v) { result.contracts = v; });
  section('myDetails', getMyDetails, function(v) { result.myDetails = v || {}; });
  section('schema', checkSchema, function(v) { result.schemaWarnings = v || []; });

  return result;
}

/**
 * Budget rules the UI should offer.
 *
 * `active` was added to this sheet by a later migration, so rules created
 * before it exists have a blank cell. getActive() would treat that as inactive
 * and hide them; here a blank means active. Kept in one function so the two
 * readings cannot drift — see getBudgetRules() for the unfiltered list.
 */
function getActiveRules() {
  return getAll('BudgetRules').filter(function(r) {
    return isTruthy(r.active) || r.active === '' || r.active === undefined || r.active === null;
  });
}

// --- Businesses ---

function addBusiness(data) {
  if (valueExists('Businesses', 'name', data.name)) {
    throw new Error('A business with this name already exists.');
  }
  data.active = true;
  if (!data.currency) data.currency = 'NZD';
  return appendRow('Businesses', data);
}

function updateBusiness(data) {
  var biz = findById('Businesses', data.business_id);
  if (!biz) throw new Error('Business not found: ' + data.business_id);

  if (data.name !== undefined) biz.name = data.name;
  if (data.contact_name !== undefined) biz.contact_name = data.contact_name;
  if (data.email !== undefined) biz.email = data.email;
  if (data.default_rate !== undefined) biz.default_rate = Number(data.default_rate) || 0;
  if (data.currency !== undefined) biz.currency = data.currency;
  if (data.address !== undefined) biz.address = data.address;

  updateRow('Businesses', biz._rowIndex, biz);
  return biz;
}

function getAllBusinesses() {
  return getAll('Businesses');
}

// --- Work Codes ---

function addWorkCode(data) {
  if (valueExists('WorkCodes', 'code_id', data.code_id)) {
    throw new Error('A work code with this ID already exists.');
  }
  data.active = true;
  if (!data.category) data.category = 'billable';
  return appendRow('WorkCodes', data);
}

function updateWorkCode(data) {
  var code = findById('WorkCodes', data.code_id);
  if (!code) throw new Error('Work code not found: ' + data.code_id);

  if (data.description !== undefined) code.description = data.description;
  if (data.category !== undefined) code.category = data.category;
  if (data.contract_id !== undefined) code.contract_id = data.contract_id;

  updateRow('WorkCodes', code._rowIndex, code);
  return code;
}

// --- Accounts ---

function addAccount(data) {
  if (valueExists('Accounts', 'name', data.name)) {
    throw new Error('An account with this name already exists.');
  }
  data.active = true;
  if (!data.currency) data.currency = 'NZD';
  return appendRow('Accounts', data);
}

// --- Budget Rules ---

function addBudgetRule(data) {
  // New rules are company rules unless told otherwise; only pre-existing rows
  // with a blank model column are treated as sole-trader.
  if (!data.model) data.model = MODEL_COMPANY;
  validateBudgetRule(data);
  data.active = true;

  if (data.is_default) {
    var existing = getAll('BudgetRules');
    existing.forEach(function(r) {
      if (r.is_default) {
        r.is_default = false;
        updateRow('BudgetRules', r._rowIndex, r);
      }
    });
  }

  return appendRow('BudgetRules', data);
}

function updateBudgetRule(data) {
  var rule = findById('BudgetRules', data.rule_id);
  if (!rule) throw new Error('Budget rule not found: ' + data.rule_id);

  // The stored model wins — an edit must never silently reinterpret a rule's
  // percentages against a different cascade.
  data.model = ruleModel(rule);
  validateBudgetRule(data);

  if (data.is_default) {
    var existing = getAll('BudgetRules');
    existing.forEach(function(r) {
      if (r.is_default && r.rule_id !== data.rule_id) {
        r.is_default = false;
        updateRow('BudgetRules', r._rowIndex, r);
      }
    });
  }

  rule.name = data.name;
  rule.model = data.model;
  pctFieldsForModel(data.model).forEach(function(field) {
    if (data[field] !== undefined) rule[field] = data[field];
  });
  rule.is_default = data.is_default;
  rule.notes = data.notes;
  updateRow('BudgetRules', rule._rowIndex, rule);
  return rule;
}

function getBudgetRules() {
  return getAll('BudgetRules');
}

// --- My Details (Invoice From) ---

function getMyDetails() {
  try {
    var rows = getAll('MyDetails');
    var details = {};
    rows.forEach(function(r) {
      details[r.key] = r.value;
    });
    return details;
  } catch (e) {
    return {};
  }
}

function saveMyDetails(data) {
  var ALLOWED_KEYS = [
    'business_name', 'contact_name', 'email', 'phone', 'address',
    'tax_number', 'gst_number', 'bank_account', 'payment_terms'
  ];

  var ss = getSpreadsheet();
  var sheet = ss.getSheetByName('MyDetails');
  if (!sheet) throw new Error('MyDetails sheet not found. Run setupSheets() first.');

  var existing = sheet.getDataRange().getValues();

  Object.keys(data).forEach(function(key) {
    if (ALLOWED_KEYS.indexOf(key) === -1) return;
    var val = sanitiseCell(data[key]);
    var found = false;
    for (var i = 1; i < existing.length; i++) {
      if (existing[i][0] === key) {
        sheet.getRange(i + 1, 2).setValue(val);
        found = true;
        break;
      }
    }
    if (!found) {
      sheet.appendRow([key, val]);
    }
  });

  return getMyDetails();
}

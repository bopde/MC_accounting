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
    contracts: [],
    myDetails: {}
  };
  try { result.businesses = getActive('Businesses'); } catch (e) {}
  try { result.workCodes = getActive('WorkCodes'); } catch (e) {}
  try { result.accounts = getActive('Accounts'); } catch (e) {}
  try {
    result.budgetRules = getAll('BudgetRules').filter(function(r) {
      return r.active === true || r.active === 'TRUE' || r.active === 'true' || r.active === '' || r.active === undefined;
    });
  } catch (e) {}
  try { result.contracts = getActiveContracts(); } catch (e) {}
  try { result.myDetails = getMyDetails(); } catch (e) { result.myDetails = {}; }
  return result;
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
  rule.tax_withheld_pct = data.tax_withheld_pct;
  rule.tax_to_pay_pct = data.tax_to_pay_pct;
  rule.acc_withheld_pct = data.acc_withheld_pct;
  rule.acc_to_pay_pct = data.acc_to_pay_pct;
  rule.donate_pct = data.donate_pct;
  rule.save_pct = data.save_pct;
  rule.invest_pct = data.invest_pct;
  rule.spend_pct = data.spend_pct;
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

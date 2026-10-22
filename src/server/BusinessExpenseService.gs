/**
 * Company operating costs, and the pots they are spent out of.
 *
 * Deliberately NOT the Expenses sheet. That one is client-rebillable: logged
 * against a client, attached to an invoice, billed on, and excluded from the
 * budget cascade because it is a pass-through. These are the opposite —
 * software, hardware, accounting fees — billed to nobody and spent out of
 * money the cascade has already set aside.
 *
 * A pot behaves unlike every other bucket. Tax and GST are owed out: allocate,
 * pay, done. A pot is a FUND — allocations fill it, spending draws it down,
 * and what matters is the balance between the two:
 *
 *   paid in (allocations you have actually moved) - spent out = balance
 *
 * Spending touches neither BudgetAllocations nor BudgetPayments, so every
 * identity the allocation cascade satisfies is untouched by it. What was
 * assigned to a pot is one question; what is left in it is another.
 */

/** Suggested categories. Free text, so this is a prompt rather than a rule. */
var BUSINESS_EXPENSE_CATEGORIES = [
  'Software', 'Hardware', 'Accounting & legal', 'Insurance',
  'Telecommunications', 'Travel', 'Training', 'Subscriptions',
  'Office', 'Bank fees', 'Other'
];

/**
 * The pots an operating cost can come out of: buckets money is HELD in rather
 * than owed out of. Spending from a tax bucket is not a thing — that money
 * belongs to the IRD.
 */
function spendablePots() {
  return allCategoryDefs()
    .filter(function(d) { return d.settle === 'hold'; })
    .map(function(d) {
      return { key: d.key, label: d.label, scope: d.scope };
    });
}

/** The pots a BUSINESS cost can come from. Today that is the Reserve alone. */
function businessPots() {
  return spendablePots().filter(function(p) { return p.scope === 'business'; });
}

function assertSpendablePot(key) {
  var found = spendablePots().filter(function(p) { return p.key === key; })[0];
  if (!found) {
    throw new Error('"' + key + '" is not a pot money can be spent from. ' +
      'Expected one of: ' + spendablePots().map(function(p) { return p.key; }).join(', ') + '.');
  }
  return found;
}

/**
 * Rows, tolerating a spreadsheet that has not been migrated yet — the app
 * warns about the missing sheet separately, and the page should still render.
 */
function businessExpenseRows() {
  try {
    return getAll('BusinessExpenses');
  } catch (e) {
    return [];
  }
}

/** Rows in the page's date range, or none at all if the sheet is missing. */
function businessExpensesInRange(params) {
  var rows = businessExpenseRows();
  if (!isFilteringParams(params)) return rows;

  var from = dateOnly(params && params.dateFrom);
  var to = dateOnly(params && params.dateTo);
  return rows.filter(function(r) {
    var d = dateOnly(r.date);
    if (!d) return false;
    if (from && d < from) return false;
    if (to && d > to) return false;
    return true;
  });
}

function assertBusinessExpensesSheet() {
  try {
    getAll('BusinessExpenses');
  } catch (e) {
    throw new Error('Business expenses cannot be recorded yet — the BusinessExpenses sheet ' +
      'is missing. Run Finance Tracker > Run setup / migrations in the spreadsheet menu, ' +
      'then try again.');
  }
}

function normaliseBusinessExpense(data) {
  var description = String(data.description == null ? '' : data.description).trim();
  if (!description) throw new Error('Give the expense a description.');

  var amount = Number(data.amount);
  if (isNaN(amount) || amount <= 0) {
    throw new Error('Amount must be a positive number (got "' + data.amount + '").');
  }

  var pot = assertSpendablePot(String(data.paid_from || '').trim());

  return {
    date: requireDate(data.date, 'Date'),
    description: description,
    category: String(data.category == null ? '' : data.category).trim(),
    amount: round2(amount),
    paid_from: pot.key,
    notes: String(data.notes == null ? '' : data.notes).trim()
  };
}

function addBusinessExpense(data) {
  return withScriptLock(function() {
    assertBusinessExpensesSheet();
    stripGeneratedId(data, 'expense_id');

    var row = normaliseBusinessExpense(data);
    row.created_date = todayLocal();
    return appendRow('BusinessExpenses', row);
  });
}

function updateBusinessExpense(data) {
  return withScriptLock(function() {
    var existing = findById('BusinessExpenses', data.expense_id);
    if (!existing) throw new Error('Business expense not found: ' + data.expense_id);

    var row = normaliseBusinessExpense(data);
    Object.keys(row).forEach(function(k) { existing[k] = row[k]; });

    updateRow('BusinessExpenses', existing._rowIndex, existing);
    return existing;
  });
}

function deleteBusinessExpense(expenseId) {
  return withScriptLock(function() {
    var existing = findById('BusinessExpenses', expenseId);
    if (!existing) throw new Error('Business expense not found: ' + expenseId);
    deleteRow('BusinessExpenses', existing._rowIndex);
    return { success: true };
  });
}

/**
 * How much has been spent out of each pot, within the page's date range.
 *
 * Filtered on the expense's OWN date, not on an invoice's — an operating cost
 * has no invoice behind it. That means a pot's balance in a narrow range can
 * look odd (allocations from one period, spending from another), which is why
 * the UI reports the range it is showing rather than implying a lifetime
 * balance.
 */
function potSpending(params) {
  // Through the tolerant reader in BOTH directions: getBudgetSummary calls
  // this, so a spreadsheet that has not been migrated must not take the whole
  // Money Flow page down with it.
  var rows = businessExpensesInRange(params);

  var byPot = {};
  rows.forEach(function(r) {
    var key = String(r.paid_from || '').trim();
    if (!key) return;
    byPot[key] = round2((byPot[key] || 0) + (Number(r.amount) || 0));
  });
  return byPot;
}

/**
 * The business expense list for the page: newest first, with the pot named.
 */
function getBusinessExpenses(params) {
  var rows = businessExpensesInRange(params);

  var potLabel = {};
  spendablePots().forEach(function(p) { potLabel[p.key] = p.label; });

  return rows.map(function(r) {
    return {
      expense_id: r.expense_id,
      date: dateOnly(r.date) || '',
      description: r.description || '',
      category: r.category || '',
      amount: Number(r.amount) || 0,
      paid_from: r.paid_from || '',
      paid_from_label: potLabel[r.paid_from] || r.paid_from || '',
      notes: r.notes || ''
    };
  }).sort(function(a, b) {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return String(a.expense_id) < String(b.expense_id) ? 1 : -1;
  });
}

/**
 * Everything the Business Expenses tab needs in one round-trip: the pots that
 * can be spent from with their balances, and the expenses themselves.
 *
 * `paidIn` is what has actually been moved into the pot, not what was
 * allocated to it — an allocation you have not acted on yet is not money
 * sitting there to spend.
 */
function getBusinessExpenseView(params) {
  return withSheetCache(function() { return buildBusinessExpenseView(params); });
}

function buildBusinessExpenseView(params) {
  // Three of these used to read BusinessExpenses separately, and two of them
  // BudgetAllocations. Inside one cache block the sheet is fetched once.
  var summary = getBudgetSummary(params);
  var spending = potSpending(params);

  var byKey = {};
  (summary.scopes || []).forEach(function(group) {
    (group.categories || []).forEach(function(cat) { byKey[cat.key] = cat; });
  });

  var pots = businessPots().map(function(p) {
    var cat = byKey[p.key] || { allocated: 0, paid: 0, outstanding: 0 };
    var spent = spending[p.key] || 0;
    return {
      key: p.key,
      label: p.label,
      allocated: round2(cat.allocated),
      paidIn: round2(cat.paid),
      stillToMoveIn: round2(cat.outstanding),
      spent: round2(spent),
      balance: round2(cat.paid - spent)
    };
  });

  return {
    pots: pots,
    categories: BUSINESS_EXPENSE_CATEGORIES,
    expenses: getBusinessExpenses(params)
  };
}

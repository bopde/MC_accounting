/**
 * Hours tracking service.
 * Handles time entries and expenses with server-side calculations.
 */

/**
 * Add a time entry. Calculates hours and line total server-side.
 */
function addTimeEntry(data) {
  if (!data.business_id || !data.date || !data.time_start || !data.time_end || !data.work_code) {
    throw new Error('Missing required fields.');
  }

  var start = parseTime(data.date, data.time_start);
  var end = parseTime(data.date, data.time_end);

  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    throw new Error('Invalid date or time values.');
  }

  if (end <= start) {
    throw new Error('End time must be after start time.');
  }

  var hours = (end - start) / (1000 * 60 * 60);
  hours = Math.round(hours * 100) / 100;

  var rate = Number(data.rate);
  if (isNaN(rate) || rate < 0) {
    throw new Error('Rate must be a non-negative number.');
  }
  var lineTotal = Math.round(hours * rate * 100) / 100;

  return appendRow('TimeEntries', {
    business_id: data.business_id,
    date: data.date,
    time_start: data.time_start,
    time_end: data.time_end,
    hours: hours,
    description: data.description,
    work_code: data.work_code,
    rate: rate,
    line_total: lineTotal,
    invoice_id: '',
    contract_id: data.contract_id || ''
  });
}

/**
 * Add an expense entry.
 */
function addExpense(data) {
  if (!data.business_id || !data.date || !data.work_code) {
    throw new Error('Missing required fields.');
  }

  var amount = Number(data.amount);
  if (isNaN(amount) || amount < 0) {
    throw new Error('Amount must be a non-negative number.');
  }

  return appendRow('Expenses', {
    business_id: data.business_id,
    date: data.date,
    amount: amount,
    description: data.description,
    work_code: data.work_code,
    invoice_id: ''
  });
}

/**
 * Get time entries filtered by year, business, and/or date range.
 * When year is provided, uses getByYear for a smaller payload.
 */
function getTimeEntries(filters) {
  filters = filters || {};
  var entries;

  if (filters.dateFrom && filters.dateTo) {
    entries = getByDateRange('TimeEntries', 'date', filters.dateFrom, filters.dateTo);
  } else if (filters.year) {
    entries = getByYear('TimeEntries', 'date', filters.year);
  } else {
    entries = getAll('TimeEntries');
  }

  if (filters.business_id) {
    entries = entries.filter(function(e) { return idsMatch(e.business_id, filters.business_id); });
  }
  if (filters.uninvoicedOnly) {
    entries = entries.filter(function(e) { return !e.invoice_id || e.invoice_id === ''; });
  }

  return entries;
}

/**
 * Get expenses filtered by year, business, and/or date range.
 */
function getExpenses(filters) {
  filters = filters || {};
  var expenses;

  if (filters.dateFrom && filters.dateTo) {
    expenses = getByDateRange('Expenses', 'date', filters.dateFrom, filters.dateTo);
  } else if (filters.year) {
    expenses = getByYear('Expenses', 'date', filters.year);
  } else {
    expenses = getAll('Expenses');
  }

  if (filters.business_id) {
    expenses = expenses.filter(function(e) { return idsMatch(e.business_id, filters.business_id); });
  }

  return expenses;
}

/**
 * Update an existing time entry. Blocked if already invoiced.
 */
function updateTimeEntry(data) {
  var entry = findById('TimeEntries', data.entry_id);
  if (!entry) throw new Error('Time entry not found: ' + data.entry_id);
  if (entry.invoice_id && entry.invoice_id !== '') {
    throw new Error('Cannot edit an invoiced entry. Void the invoice first.');
  }

  if (!data.business_id || !data.date || !data.time_start || !data.time_end || !data.work_code) {
    throw new Error('Missing required fields.');
  }

  var start = parseTime(data.date, data.time_start);
  var end = parseTime(data.date, data.time_end);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) throw new Error('Invalid date or time values.');
  if (end <= start) throw new Error('End time must be after start time.');

  var hours = Math.round((end - start) / (1000 * 60 * 60) * 100) / 100;
  var rate = Number(data.rate);
  if (isNaN(rate) || rate < 0) throw new Error('Rate must be a non-negative number.');
  var lineTotal = Math.round(hours * rate * 100) / 100;

  entry.business_id = data.business_id;
  entry.date = data.date;
  entry.time_start = data.time_start;
  entry.time_end = data.time_end;
  entry.hours = hours;
  entry.description = data.description;
  entry.work_code = data.work_code;
  entry.rate = rate;
  entry.line_total = lineTotal;
  entry.contract_id = data.contract_id || '';

  updateRow('TimeEntries', entry._rowIndex, entry);
  return entry;
}

/**
 * Delete a time entry. Blocked if already invoiced.
 */
function deleteTimeEntry(entryId) {
  var entry = findById('TimeEntries', entryId);
  if (!entry) throw new Error('Time entry not found: ' + entryId);
  if (entry.invoice_id && entry.invoice_id !== '') {
    throw new Error('Cannot delete an invoiced entry. Void the invoice first.');
  }
  deleteRow('TimeEntries', entry._rowIndex);
  return { success: true };
}

/**
 * Update an existing expense. Blocked if already invoiced.
 */
function updateExpense(data) {
  var expense = findById('Expenses', data.expense_id);
  if (!expense) throw new Error('Expense not found: ' + data.expense_id);
  if (expense.invoice_id && expense.invoice_id !== '') {
    throw new Error('Cannot edit an invoiced expense. Void the invoice first.');
  }

  if (!data.business_id || !data.date || !data.work_code) {
    throw new Error('Missing required fields.');
  }

  var amount = Number(data.amount);
  if (isNaN(amount) || amount < 0) throw new Error('Amount must be a non-negative number.');

  expense.business_id = data.business_id;
  expense.date = data.date;
  expense.amount = amount;
  expense.description = data.description;
  expense.work_code = data.work_code;

  updateRow('Expenses', expense._rowIndex, expense);
  return expense;
}

/**
 * Delete an expense. Blocked if already invoiced.
 */
function deleteExpense(expenseId) {
  var expense = findById('Expenses', expenseId);
  if (!expense) throw new Error('Expense not found: ' + expenseId);
  if (expense.invoice_id && expense.invoice_id !== '') {
    throw new Error('Cannot delete an invoiced expense. Void the invoice first.');
  }
  deleteRow('Expenses', expense._rowIndex);
  return { success: true };
}

/**
 * Parse a date (YYYY-MM-DD) + time (HH:MM) into a local Date object.
 */
function parseTime(dateStr, timeStr) {
  var dp = String(dateStr).split('-');
  var tp = String(timeStr).split(':');
  return new Date(+dp[0], +dp[1] - 1, +dp[2], +tp[0], +tp[1], 0);
}

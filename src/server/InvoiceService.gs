/**
 * Invoice generation and management service.
 */

/**
 * Get uninvoiced time entries and expenses for a business within a date range.
 * Called internally by generateInvoice. Client calls go through ClientWrappers.gs.
 */
function getUninvoicedItemsInternal(businessId, dateFrom, dateTo, contractId) {
  var fromStr = dateOnly(dateFrom);
  var toStr = dateOnly(dateTo);
  var conIdStr = contractId ? String(contractId) : '';

  var timeEntries = getAll('TimeEntries').filter(function(te) {
    var d = dateOnly(te.date);
    if (!idsMatch(te.business_id, businessId)) return false;
    if (te.invoice_id && te.invoice_id !== '') return false;
    if (d < fromStr || d > toStr) return false;
    if (conIdStr && !idsMatch(te.contract_id || '', conIdStr)) return false;
    return true;
  });

  var expenses = getAll('Expenses').filter(function(exp) {
    var d = dateOnly(exp.date);
    if (!idsMatch(exp.business_id, businessId)) return false;
    if (exp.invoice_id && exp.invoice_id !== '') return false;
    if (d < fromStr || d > toStr) return false;
    return true;
  });

  return { timeEntries: timeEntries, expenses: expenses };
}

/**
 * Generate an invoice from time entries and expenses.
 * Marks all included items as invoiced.
 *
 * @param {Object} params - {
 *   businessId, dateFrom, dateTo, includeGst, gstRate,
 *   description, notes, lineDescriptions: { workCode: "description" }
 * }
 * @returns {Object} The created invoice
 */
function generateInvoice(params) {
  var items = getUninvoicedItemsInternal(params.businessId, params.dateFrom, params.dateTo, params.contractId);

  if (items.timeEntries.length === 0 && items.expenses.length === 0) {
    throw new Error('No uninvoiced items found for the selected period.');
  }

  // Calculate subtotal from time entries
  var timeSubtotal = items.timeEntries.reduce(function(sum, te) {
    return sum + (Number(te.line_total) || 0);
  }, 0);

  // Calculate subtotal from expenses
  var expenseSubtotal = items.expenses.reduce(function(sum, exp) {
    return sum + (Number(exp.amount) || 0);
  }, 0);

  var subtotal = timeSubtotal + expenseSubtotal;

  // GST applies to time entries (services) only, not expenses
  var includeGst = isTruthy(params.includeGst);
  var gstRate = includeGst ? (params.gstRate != null ? Number(params.gstRate) : 0.15) : 0;
  var gstAmount = includeGst ? Math.round(timeSubtotal * gstRate * 100) / 100 : 0;
  var total = subtotal + gstAmount;

  // Generate MMYY invoice ID based on the period end date
  var invoiceId = generateInvoiceId(params.dateTo);

  var invoice = appendRow('Invoices', {
    invoice_id: invoiceId,
    business_id: params.businessId,
    date_from: params.dateFrom,
    date_to: params.dateTo,
    created_date: params.dateTo,
    include_gst: includeGst,
    gst_rate: gstRate,
    time_subtotal: timeSubtotal,
    subtotal: subtotal,
    gst_amount: gstAmount,
    total: total,
    status: 'draft',
    budget_rule_id: '',
    contract_id: params.contractId || '',
    po_number: params.poNumber || '',
    description: params.description || '',
    notes: params.notes || '',
    line_descriptions: params.lineDescriptions ? JSON.stringify(params.lineDescriptions) : ''
  });

  // Mark time entries as invoiced (force text format to preserve leading zeros)
  var ss = getSpreadsheet();
  var teSheet = ss.getSheetByName('TimeEntries');
  var teInvCol = getColumnIndex(teSheet, 'invoice_id');
  items.timeEntries.forEach(function(te) {
    var cell = teSheet.getRange(te._rowIndex, teInvCol);
    cell.setNumberFormat('@');
    cell.setValue(invoice.invoice_id);
  });

  // Mark expenses as invoiced
  var expSheet = ss.getSheetByName('Expenses');
  var expInvCol = getColumnIndex(expSheet, 'invoice_id');
  items.expenses.forEach(function(exp) {
    var cell = expSheet.getRange(exp._rowIndex, expInvCol);
    cell.setNumberFormat('@');
    cell.setValue(invoice.invoice_id);
  });

  return invoice;
}

/**
 * Get full invoice data including line items for display/printing.
 */
function getInvoiceDetails(invoiceId) {
  var invoice = findById('Invoices', invoiceId);
  if (!invoice) throw new Error('Invoice not found: ' + invoiceId);

  var business = findById('Businesses', invoice.business_id);

  var invIdStr = String(invoiceId);
  var timeEntries = getAll('TimeEntries').filter(function(te) {
    return idsMatch(te.invoice_id, invIdStr);
  });

  var expenses = getAll('Expenses').filter(function(exp) {
    return idsMatch(exp.invoice_id, invIdStr);
  });

  // Parse stored line descriptions
  var lineDescs = {};
  if (invoice.line_descriptions) {
    try { lineDescs = JSON.parse(invoice.line_descriptions); } catch (e) {}
  }

  // Group time entries by work code
  var codeGroups = {};
  timeEntries.forEach(function(te) {
    var code = te.work_code;
    if (!codeGroups[code]) {
      codeGroups[code] = { code: code, description: lineDescs[code] || '', entries: [], totalHours: 0, totalAmount: 0, rate: 0 };
    }
    codeGroups[code].entries.push(te);
    codeGroups[code].totalHours += Number(te.hours) || 0;
    codeGroups[code].totalAmount += Number(te.line_total) || 0;
    if (te.rate) codeGroups[code].rate = Number(te.rate);
  });

  // Get allocations if they exist
  var allocations = getAll('BudgetAllocations').filter(function(a) {
    return idsMatch(a.invoice_id, invoiceId);
  });

  // Get "my details" for the invoice header
  var myDetails = getMyDetails();

  var codeGroupList = Object.keys(codeGroups).map(function(k) {
    var g = codeGroups[k];
    return { code: g.code, description: g.description, totalHours: g.totalHours, totalAmount: g.totalAmount, rate: g.rate };
  });

  var timeSubtotal = codeGroupList.reduce(function(s, g) { return s + g.totalAmount; }, 0);
  var expenseSubtotal = expenses.reduce(function(s, e) { return s + (Number(e.amount) || 0); }, 0);

  return {
    invoice: invoice,
    business: business,
    myDetails: myDetails,
    codeGroups: codeGroupList,
    timeEntryCount: timeEntries.length,
    timeSubtotal: timeSubtotal,
    expenseSubtotal: expenseSubtotal,
    expenses: expenses,
    allocations: allocations
  };
}

/**
 * Update invoice status (draft -> sent -> paid).
 */
function updateInvoiceStatus(invoiceId, newStatus) {
  var validTransitions = {
    draft: ['sent', 'void'],
    sent: ['paid', 'void'],
    paid: ['void'],
    void: []
  };

  var invoice = findById('Invoices', invoiceId);
  if (!invoice) throw new Error('Invoice not found: ' + invoiceId);

  var allowed = validTransitions[invoice.status] || [];
  if (allowed.indexOf(newStatus) === -1) {
    throw new Error('Cannot change status from "' + invoice.status + '" to "' + newStatus + '".');
  }

  if (newStatus === 'void') {
    return voidInvoice(invoice);
  }

  invoice.status = newStatus;
  updateRow('Invoices', invoice._rowIndex, invoice);
  return invoice;
}

/**
 * Void an invoice: block if budget allocations exist, then unlink
 * time entries and expenses so they can be re-invoiced.
 */
function voidInvoice(invoice) {
  var invIdStr = String(invoice.invoice_id);
  var allocations = getAll('BudgetAllocations').filter(function(a) {
    return idsMatch(a.invoice_id, invIdStr);
  });
  if (allocations.length > 0) {
    throw new Error('Cannot void — this invoice has budget allocations. Remove them first.');
  }

  var ss = getSpreadsheet();

  // Unlink time entries
  var teSheet = ss.getSheetByName('TimeEntries');
  if (teSheet) {
    var teInvCol = getColumnIndex(teSheet, 'invoice_id');
    var teAll = getAll('TimeEntries');
    teAll.forEach(function(te) {
      if (idsMatch(te.invoice_id, invIdStr)) {
        teSheet.getRange(te._rowIndex, teInvCol).setValue('');
      }
    });
  }

  // Unlink expenses
  var expSheet = ss.getSheetByName('Expenses');
  if (expSheet) {
    var expInvCol = getColumnIndex(expSheet, 'invoice_id');
    var expAll = getAll('Expenses');
    expAll.forEach(function(exp) {
      if (idsMatch(exp.invoice_id, invIdStr)) {
        expSheet.getRange(exp._rowIndex, expInvCol).setValue('');
      }
    });
  }

  invoice.status = 'void';
  updateRow('Invoices', invoice._rowIndex, invoice);
  return invoice;
}

/**
 * Update editable invoice fields: description, notes, GST toggle/rate.
 * Recalculates GST and total when include_gst or gst_rate changes.
 *
 * Expects an object with: invoice_id, and any of:
 *   description, notes, include_gst, gst_rate
 */
function updateInvoice(params) {
  var invoice = findById('Invoices', params.invoice_id);
  if (!invoice) throw new Error('Invoice not found: ' + params.invoice_id);

  if (invoice.status === 'paid' || invoice.status === 'void') {
    throw new Error('Cannot edit a ' + invoice.status + ' invoice.');
  }

  if (params.created_date !== undefined && params.created_date !== '') invoice.created_date = params.created_date;
  if (params.description !== undefined) invoice.description = params.description;
  if (params.notes !== undefined) invoice.notes = params.notes;
  if (params.line_descriptions !== undefined) {
    invoice.line_descriptions = typeof params.line_descriptions === 'string'
      ? params.line_descriptions
      : JSON.stringify(params.line_descriptions);
  }

  var recalc = false;
  if (params.include_gst !== undefined) {
    invoice.include_gst = isTruthy(params.include_gst);
    recalc = true;
  }
  if (params.gst_rate !== undefined && params.gst_rate !== '') {
    invoice.gst_rate = Number(params.gst_rate) || 0;
    recalc = true;
  }

  if (recalc) {
    var gstBase = (invoice.time_subtotal != null && invoice.time_subtotal !== '')
      ? Number(invoice.time_subtotal) : (Number(invoice.subtotal) || 0);
    var subtotal = Number(invoice.subtotal) || 0;
    var includeGst = isTruthy(invoice.include_gst);
    var rate = includeGst ? (Number(invoice.gst_rate) || 0) : 0;
    var gstAmount = includeGst ? Math.round(gstBase * rate * 100) / 100 : 0;
    var newTotal = subtotal + gstAmount;

    // If the total is changing and the invoice is already allocated,
    // block the edit — the allocations would become inconsistent.
    if (Math.abs(newTotal - (Number(invoice.total) || 0)) > 0.005) {
      var hasAllocations = getAll('BudgetAllocations').some(function(a) {
        return idsMatch(a.invoice_id, invoice.invoice_id);
      });
      if (hasAllocations) {
        throw new Error('This invoice is already allocated. Changing the total would desync the budget. Remove the allocation first, or edit before allocating.');
      }
    }

    invoice.gst_amount = gstAmount;
    invoice.total = newTotal;
  }

  updateRow('Invoices', invoice._rowIndex, invoice);
  return invoice;
}

/**
 * Get invoices with business name and currency.
 * Accepts params object with dateFrom/dateTo, or a year string for backwards compat.
 */
function getInvoicesWithDetails(params) {
  var invoices;
  if (typeof params === 'object' && params !== null && params.dateFrom) {
    invoices = getByDateRange('Invoices', 'created_date', params.dateFrom, params.dateTo);
  } else if (params) {
    invoices = getByYear('Invoices', 'created_date', params);
  } else {
    invoices = getAll('Invoices');
  }
  var businesses = getAll('Businesses');
  var bizMap = {};
  businesses.forEach(function(b) { bizMap[normalizeId(b.business_id)] = b; });

  return invoices.map(function(inv) {
    var biz = bizMap[normalizeId(inv.business_id)];
    inv.business_name = biz ? biz.name : 'Unknown';
    inv.currency = biz ? biz.currency : 'NZD';
    return inv;
  });
}

/**
 * Generate invoice ID in MMYY format based on the period end date.
 * E.g. dateTo of "2026-05-31" → "0526".
 * Subsequent invoices in the same month get a letter suffix: 0526a, 0526b, etc.
 */
function generateInvoiceId(dateTo) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var parts = String(dateTo).split('-');
    var mm = parts[1];
    var yy = parts[0].slice(-2);
    var base = mm + yy;

    var invoices = getAll('Invoices');
    var baseNum = base.replace(/^0+/, '');
    var pattern = new RegExp('^0*' + baseNum + '([a-z]*)$');
    var maxSuffix = '';
    var count = 0;
    invoices.forEach(function(inv) {
      var m = pattern.exec(String(inv.invoice_id));
      if (m) {
        count++;
        if (m[1] > maxSuffix) maxSuffix = m[1];
      }
    });

    if (count === 0) return base;

    // Next suffix after the highest existing one
    var nextChar = maxSuffix === '' ? 'a' : nextSuffix(maxSuffix);
    return base + nextChar;
  } finally {
    lock.releaseLock();
  }
}

function nextSuffix(s) {
  var chars = s.split('');
  var i = chars.length - 1;
  while (i >= 0) {
    if (chars[i] < 'z') { chars[i] = String.fromCharCode(chars[i].charCodeAt(0) + 1); return chars.join(''); }
    chars[i] = 'a';
    i--;
  }
  return 'a' + chars.join('');
}

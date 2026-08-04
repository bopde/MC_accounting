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

  var contract = conIdStr ? findById('Contracts', conIdStr) : null;
  var conFrom = contract ? dateOnly(contract.date_from) : '';
  var conTo = contract ? dateOnly(contract.date_to) : '';

  /**
   * A row with a contract must match the selected one. A row with NO contract
   * counts towards it when the date falls inside the contract's period —
   * matching how the dashboard already attributes unassigned work
   * (DashboardService.contractProgress). Strict matching used to drop every
   * entry logged before contracts existed, or left as "None".
   */
  function matchesContract(row, d) {
    if (!conIdStr) return true;
    var rowContract = row.contract_id ? String(row.contract_id) : '';
    if (rowContract) return idsMatch(rowContract, conIdStr);
    if (!d) return false;
    if (conFrom && d < conFrom) return false;
    if (conTo && d > conTo) return false;
    return true;
  }

  /** Each bound guarded separately: `d > ''` is true, so an unset dateTo
   *  would otherwise exclude every row instead of leaving the range open. */
  function inDateRange(d) {
    if (!d) return false;
    if (fromStr && d < fromStr) return false;
    if (toStr && d > toStr) return false;
    return true;
  }

  var timeEntries = getAll('TimeEntries').filter(function(te) {
    var d = dateOnly(te.date);
    if (!idsMatch(te.business_id, businessId)) return false;
    if (te.invoice_id && te.invoice_id !== '') return false;
    if (!inDateRange(d)) return false;
    return matchesContract(te, d);
  });

  var expenses = getAll('Expenses').filter(function(exp) {
    var d = dateOnly(exp.date);
    if (!idsMatch(exp.business_id, businessId)) return false;
    if (exp.invoice_id && exp.invoice_id !== '') return false;
    if (!inDateRange(d)) return false;
    return matchesContract(exp, d);
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
  // One lock across select-items -> write invoice -> stamp items. Without it,
  // two submissions for the same business and period both see the same
  // uninvoiced entries and bill them twice, and both can compute the same
  // invoice ID.
  return withScriptLock(function() {
    return generateInvoiceLocked(params);
  }, 60000);
}

function generateInvoiceLocked(params) {
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
  var invoiceId = generateInvoiceId(params.dateTo, params.businessId);

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

  var ss = getSpreadsheet();
  stampInvoiceId(ss.getSheetByName('TimeEntries'), items.timeEntries, invoice.invoice_id);
  stampInvoiceId(ss.getSheetByName('Expenses'), items.expenses, invoice.invoice_id);

  return invoice;
}

/**
 * Stamp invoice_id onto a set of rows.
 *
 * Batched into contiguous runs rather than two API calls per row: a 150-entry
 * invoice used to make 300 calls, which pushed past the client's 45s timeout —
 * and since a timeout is not a cancellation, the user would retry and get a
 * second invoice covering whatever the first pass had not yet stamped.
 *
 * Text format is forced to preserve leading zeros in IDs like '0526'.
 */
function stampInvoiceId(sheet, rows, invoiceId) {
  if (!sheet || !rows || rows.length === 0) return;

  var col = getColumnIndex(sheet, 'invoice_id');
  var indexes = rows.map(function(r) { return r._rowIndex; })
    .filter(function(i) { return !!i; })
    .sort(function(a, b) { return a - b; });
  if (indexes.length === 0) return;

  var runStart = indexes[0];
  var runEnd = indexes[0];

  var flush = function() {
    var height = runEnd - runStart + 1;
    var values = [];
    for (var i = 0; i < height; i++) values.push([invoiceId]);
    sheet.getRange(runStart, col, height, 1).setNumberFormat('@').setValues(values);
  };

  for (var i = 1; i < indexes.length; i++) {
    if (indexes[i] === runEnd + 1) {
      runEnd = indexes[i];
    } else {
      flush();
      runStart = indexes[i];
      runEnd = indexes[i];
    }
  }
  flush();
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
  if (params.po_number !== undefined) invoice.po_number = String(params.po_number).trim();
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
  var invoices = getByDateParams('Invoices', 'created_date', params);
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
 * Words that carry no identity, so they are skipped when deriving initials.
 * "Ministry of Business and Employment" -> MBE, not MOBAE.
 */
var INVOICE_PREFIX_STOPWORDS = ['of', 'the', 'and', 'a', 'an', 'for', 'at',
  'ltd', 'limited', 'inc', 'incorporated', 'llc', 'llp', 'plc', 'pty', 'co', 'nz'];

var INVOICE_PREFIX_MAX = 3;
var INVOICE_CODE_MAX = 6;

/**
 * Clean a prefix to the characters an invoice id may safely carry.
 *
 * Leading digits are dropped, which is not cosmetic: normalizeId() strips
 * leading zeros from every id it compares (Sheets turns a bare '0526' into the
 * number 526), so a prefix beginning with 0 makes ids alias each other —
 * '0S0526' and 'S0526' both normalise to 'S0526', and '00526' collides with a
 * legacy '0526'. findById would then return the wrong invoice, and voiding or
 * allocating would hit the wrong record. Requiring a letter first removes the
 * whole class.
 */
function normaliseInvoicePrefix(value) {
  return String(value == null ? '' : value)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/^[0-9]+/, '');
}

/**
 * The invoice-ID prefix for a business: "Auckland Transport" -> "AT".
 *
 * An explicit invoice_code on the business always wins — needed when the
 * initials read badly, or when two clients would otherwise share a prefix.
 * Otherwise: one letter per significant word, or the first two letters when the
 * name is a single word, capped at INVOICE_PREFIX_MAX characters. An explicit
 * code may run to INVOICE_CODE_MAX.
 *
 * Returns '' when there is no usable name, which falls back to the old
 * prefix-less MMYY id rather than failing the invoice.
 */
function businessInvoicePrefix(business) {
  if (!business) return '';

  var explicit = normaliseInvoicePrefix(business.invoice_code);
  if (explicit) return explicit.slice(0, INVOICE_CODE_MAX);

  var words = String(business.name || '').split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (words.length === 0) return '';

  var significant = words.filter(function(w) {
    if (INVOICE_PREFIX_STOPWORDS.indexOf(w.toLowerCase()) !== -1) return false;
    // Drop one-letter fragments: splitting on punctuation turns "Bob's Bakery"
    // into Bob / s / Bakery, and that stray 's' would give BSB instead of BB.
    return w.length > 1;
  });
  // Unless dropping them left nothing — "H & M" is genuinely single letters.
  if (significant.length === 0) {
    significant = words.filter(function(w) {
      return INVOICE_PREFIX_STOPWORDS.indexOf(w.toLowerCase()) === -1;
    });
  }
  if (significant.length === 0) significant = words;

  var raw = significant.length === 1
    ? significant[0].slice(0, 2)
    : significant.map(function(w) { return w.charAt(0); }).join('');

  return normaliseInvoicePrefix(raw).slice(0, INVOICE_PREFIX_MAX);
}

/**
 * Generate an invoice ID: business prefix + MMYY of the period end date.
 * E.g. Auckland Transport for May 2026 -> "AT0526".
 * Further invoices for the SAME business in the SAME month get a letter
 * suffix: AT0526a, AT0526b, ...
 *
 * With no business (or an unusable name) the id falls back to bare MMYY, which
 * is the format every invoice used before prefixes existed.
 */
function generateInvoiceId(dateTo, businessId) {
  // Re-entrant: generateInvoice already holds the lock across the scan and the
  // write, which is what stops two submissions computing the same ID. Taking
  // and releasing a separate lock here would leave that window open.
  return withScriptLock(function() {
    // Normalise first: a Date object or a malformed string used to slice into
    // nonsense, producing ids like "ATundefined" — or, when the value contained
    // a bracket, an unmatched-paren error from the pattern built below.
    var iso = dateOnly(dateTo);
    if (!iso) {
      throw new Error('Cannot generate an invoice number: "' + dateTo +
        '" is not a valid period end date. Expected YYYY-MM-DD.');
    }

    var parts = iso.split('-');
    var mm = parts[1];
    var yy = parts[0].slice(-2);
    var base = mm + yy;

    var business = businessId ? findById('Businesses', businessId) : null;
    var prefix = businessInvoicePrefix(business);
    var stem = prefix + base;

    var invoices = getAll('Invoices');

    // Count prior invoices by BUSINESS AND MONTH, not by matching the id text.
    // Matching text meant a renamed business restarted its sequence — "Acme"
    // (AC0526) becoming "Acme Digital" produced a second unsuffixed invoice for
    // the same client and month — and two clients sharing a prefix interleaved
    // one sequence, giving each of them a gappy run.
    //
    // With no business we cannot scope it, so fall back to matching the bare
    // MMYY text, which is what every pre-prefix invoice used. Only there is the
    // stripped-leading-zero tolerance needed: Sheets stores '0526' as 526.
    var priorCount;
    if (businessId) {
      priorCount = invoices.filter(function(inv) {
        if (!idsMatch(inv.business_id, businessId)) return false;
        var d = dateOnly(inv.date_to || inv.created_date);
        return d.slice(0, 4) === parts[0] && d.slice(5, 7) === mm;
      }).length;
    } else {
      var baseNum = base.replace(/^0+/, '');
      var barePattern = new RegExp('^0*' + baseNum + '([a-z]*)$', 'i');
      priorCount = invoices.filter(function(inv) {
        return barePattern.test(String(inv.invoice_id));
      }).length;
    }

    var taken = {};
    var highest = '';
    invoices.forEach(function(inv) {
      var id = String(inv.invoice_id).trim();
      taken[id.toUpperCase()] = true;

      // Highest suffix already issued under THIS stem. A number that has been
      // used must never be reused, even if the invoice was later deleted — a
      // client's records may still refer to it. So the sequence only ever moves
      // forward, never fills a hole.
      if (id.toUpperCase().indexOf(stem.toUpperCase()) !== 0) return;
      var tail = id.slice(stem.length).toLowerCase();
      if (!/^[a-z]*$/.test(tail)) return;
      if (suffixIndex(tail) > suffixIndex(highest)) highest = tail;
    });

    // Position by count so a rename or a shared prefix cannot restart the
    // sequence, but never at or below a suffix already used under this stem.
    var start = priorCount === 0 ? 0 : Math.max(priorCount, suffixIndex(highest) + 1);

    var suffix = '';
    while (suffixIndex(suffix) < start || taken[(stem + suffix).toUpperCase()]) {
      suffix = suffix === '' ? 'a' : nextSuffix(suffix);
    }

    return stem + suffix;
  });
}

/**
 * Position of a suffix in the sequence: '' -> 0, a -> 1, z -> 26, aa -> 27.
 * Bijective base-26, so suffixes compare as numbers rather than as strings —
 * plain '>' puts 'aa' below 'z'.
 */
function suffixIndex(suffix) {
  var n = 0;
  var s = String(suffix || '');
  for (var i = 0; i < s.length; i++) {
    n = n * 26 + (s.charCodeAt(i) - 96);
  }
  return n;
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

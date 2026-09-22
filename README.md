# Finance Tracker

A personal finance management web app built entirely on Google Apps Script with Google Sheets as the backend. Designed for consultants who work with multiple businesses, need to track hours, generate invoices, allocate budgets, and monitor accounts across currencies.

**All code runs within the Google Apps Script sandbox. No external servers, no databases, no third-party APIs.**

---

## Table of Contents

- [Features](#features)
- [Architecture](#architecture)
- [External Services & Security](#external-services--security)
- [Google Sheets Structure](#google-sheets-structure)
- [Setup & Deployment](#setup--deployment)
- [Usage Guide](#usage-guide)
- [Project Structure](#project-structure)
- [Function Reference](#function-reference)
- [Troubleshooting](#troubleshooting)

---

## Features

### 1. Hours & Expenses
- Log time entries with business, work code, start/end times. Hours and line totals calculated server-side.
- Log expenses with date, amount, description, and work code.
- Filter entries by business, date range, or invoiced status.
- Selecting a business auto-fills the default hourly rate and currency.

### 2. Invoices
- Generate invoices from uninvoiced time entries and expenses for a business and date range.
- Optional GST at a configurable rate (default 15%). Record tax already withheld by the payer.
- Print-friendly invoice view with your details ("From"), client details ("Bill To"), itemised services grouped by work code, and expenses listed individually.
- Status flow: draft -> sent -> paid -> void.
- Entries are marked with the invoice ID once invoiced, preventing double-billing.

### 3. Budget Allocations
- Define percentage splits across 8 categories: **Tax Withheld, Tax To Pay, ACC Withheld, ACC To Pay, Donate, Save, Invest, Spend**.
- "Tax Withheld" and "ACC Withheld" apply to the gross total. All other categories split the net (total minus withheld). Withheld allocations are auto-marked as "transferred."
- Only paid invoices can be allocated. Track each allocation as pending -> transferred -> reconciled.
- Summary dashboard with per-category totals and per-invoice drill-down.

### 4. Account Summaries
- Enter monthly snapshots for each account: EOM balance, realised/unrealised gains, tax paid, notes.
- 15-month year overview (Jan-Dec + Jan-Mar following year) with month-over-month balance changes colour-coded.
- Upsert logic: re-entering data for an existing account+month updates rather than duplicates.

### 5. Settings
- **My Details**: Name, address, email, phone, tax number, GST number, bank account, payment terms. Appears on invoices.
- **Businesses**: Client name, contact, email, address, default rate, currency. Soft-delete to preserve history.
- **Work Codes**: Short codes (DEV, DESIGN, etc.) with descriptions and categories.
- **Accounts**: Bank, investment, hold, crypto, or other accounts with currency and purpose.
- **Budget Rules**: Named percentage-split templates. One can be marked as default.

All configuration is editable from the frontend. Dropdowns suggest existing entries to prevent duplication.

---

## Architecture

### How It Works

```
Browser (your computer)
    |
    |  Loads HTML/CSS/JS via HtmlService
    v
Google Apps Script Web App
    |
    |  google.script.run (RPC calls)
    v
Server-side .gs functions
    |
    |  SpreadsheetApp API
    v
Google Spreadsheet (your private Sheet)
```

1. **Entry point**: `doGet()` in `Main.gs` serves `index.html` via `HtmlService`. All client files (JS, CSS) are inlined using `<?!= include() ?>` template directives.
2. **Client SPA**: A hash-based router (`#hours`, `#invoices`, etc.) in `app.js.html` handles page navigation. On each route change, reference data is loaded from cache (or fetched from the server), then the page render function is called.
3. **Client-server RPC**: Client code calls server functions via `google.script.run`, wrapped in a Promise-based `serverCall()` utility with a 15-second timeout. Functions that need multiple arguments use pipe-delimited strings through `ClientWrappers.gs`.
4. **Data layer**: `SheetService.gs` provides generic CRUD (getAll, appendRow, updateRow, findById). Each service module (Hours, Invoice, Budget, Account, Settings) builds on these primitives. `getSpreadsheet()` calls `SpreadsheetApp.getActiveSpreadsheet()` -- no ID configuration needed because the script is bound to its spreadsheet.
5. **ID generation**: `IdService.gs` generates sequential IDs (TE-001, EXP-001, INV-2026-001, etc.) using `LockService` to prevent race conditions across concurrent tabs.
6. **Caching**: `AppCache` on the client stores reference data (businesses, work codes, accounts, budget rules, my details) to reduce server round-trips. The cache is cleared on settings changes.

### Security Model

| Layer | Protection |
|-------|-----------|
| **Source code** | Public on GitHub. Contains zero credentials or sensitive data. |
| **Script ID** | `.clasp.json` is gitignored. Only `.clasp.json.example` is committed. |
| **OAuth scope** | `spreadsheets.currentonly` -- the script can only access the spreadsheet it's bound to, not any other file in your Google account. |
| **Spreadsheet data** | Private Google Sheet, not shared with anyone. |
| **Web app access** | Deployed as "Execute as: Me" with "Only myself" access. |

### Data Integrity

- **Dropdown-driven entry**: Businesses, work codes, and accounts are selected from dropdowns.
- **Sequential IDs with locking**: `LockService` prevents duplicate IDs across concurrent sessions.
- **Foreign keys by ID**: Renaming a business updates display everywhere automatically.
- **Soft deletes**: Deactivating reference data hides it from dropdowns but preserves historical records.
- **Upsert for summaries**: Account summaries for the same account+month are updated, not duplicated.
- **Dynamic column lookups**: Column indices resolved by header name, not hardcoded positions.

---

## External Services & Security

This section lists **every external service** the app contacts. There are only two, and one of them is optional.

### 1. Google Apps Script Built-in APIs (required)

These are Google's own APIs, accessed within the Apps Script sandbox. No network calls leave Google's infrastructure.

| API | Used By | Purpose |
|-----|---------|---------|
| `SpreadsheetApp` | SheetService.gs, Setup.gs, IdService.gs, ClientWrappers.gs | Read/write the bound spreadsheet |
| `LockService` | IdService.gs | Prevent concurrent ID collisions |
| `HtmlService` | Main.gs | Serve the web app HTML |
| `google.script.run` | utils.js.html (client) | Client-to-server RPC mechanism |

### 2. Pico CSS CDN (optional, removable)

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.min.css">
```

**File**: `src/client/index.html`, line 7

This is the **only external network request** made by the client. It loads the Pico CSS framework from the jsDelivr CDN for styling. To eliminate this dependency entirely:

1. Download the CSS file
2. Paste its contents into a new `pico.css.html` file wrapped in `<style>` tags
3. Replace the `<link>` tag with `<?!= include('client/css/pico.css') ?>`

### What is NOT used

- No external APIs (Stripe, PayPal, exchange rate services, etc.)
- No analytics or tracking scripts
- No authentication libraries (relies entirely on Google account)
- No server-side HTTP fetches (`UrlFetchApp` is not used anywhere)
- No external databases

---

## Google Sheets Structure

The spreadsheet has **10 tabs**, created automatically by `setupSheets()`:

| Tab | Purpose | Key Fields |
|-----|---------|-----------|
| **MyDetails** | Invoice "From" details (key/value pairs) | key, value |
| **Businesses** | Client/employer reference data | business_id, name, contact_name, email, address, default_rate, currency, active |
| **WorkCodes** | Job classification codes | code_id, description, category, active |
| **Accounts** | Bank/investment accounts | account_id, name, type, currency, purpose, active |
| **BudgetRules** | Budget percentage templates | rule_id, name, is_default, tax_withheld_pct ... spend_pct, active |
| **TimeEntries** | Logged work hours | entry_id, business_id, date, start_time, end_time, hours, work_code, rate, line_total, description, invoice_id |
| **Expenses** | Reimbursable expenses | expense_id, business_id, date, amount, description, work_code, invoice_id |
| **Invoices** | Generated invoices | invoice_id, business_id, date_from, date_to, created_date, subtotal, gst, total, status, notes, include_gst, gst_rate, tax_withheld, budget_rule_id |
| **BudgetAllocations** | Per-invoice budget splits | allocation_id, invoice_id, category, amount, status, transfer_date |
| **AccountSummaries** | Monthly account snapshots | summary_id, account_id, month, eom_balance, realised_gains, unrealised_gains, tax_paid, notes |

### Relationships

```
Businesses ---< TimeEntries    (business_id)
Businesses ---< Expenses       (business_id)
Businesses ---< Invoices       (business_id)
WorkCodes  ---< TimeEntries    (work_code)
WorkCodes  ---< Expenses       (work_code)
Invoices   ---< TimeEntries    (invoice_id, set when invoiced)
Invoices   ---< Expenses       (invoice_id, set when invoiced)
Invoices   ---< BudgetAllocations (invoice_id)
BudgetRules --< Invoices       (budget_rule_id, set when allocated)
Accounts   ---< AccountSummaries (account_id)
```

---

## Setup & Deployment

### Prerequisites

- A Google account
- A Google Spreadsheet (create a new blank one)

### Important: Container-Bound Script

This app is designed as a **container-bound** script -- meaning it is created from *within* the spreadsheet, not as a standalone project. This is what allows the narrow `spreadsheets.currentonly` permission scope: the script can only touch the one spreadsheet it lives inside.

### Option A: Using clasp (Recommended)

[clasp](https://github.com/google/clasp) is Google's CLI tool for managing Apps Script projects. It lets you push code from your local repo directly to Apps Script.

```bash
# 1. Install clasp globally
npm install -g @google/clasp

# 2. Log in to your Google account
clasp login

# 3. Create the Apps Script project BOUND to your spreadsheet.
#    First, open your spreadsheet, go to Extensions > Apps Script.
#    This creates a container-bound script. Copy the script ID from
#    the URL: https://script.google.com/home/projects/SCRIPT_ID/edit
#
#    Then create .clasp.json locally:
echo '{ "scriptId": "YOUR_SCRIPT_ID", "rootDir": "src" }' > .clasp.json

# 4. DO NOT commit .clasp.json (it's already in .gitignore).

# 5. Push all source files to Apps Script
clasp push

# 6. Open the Apps Script editor in your browser
clasp open
```

Then in the Apps Script editor:

1. In the editor, run the `setupSheets` function (select it from the function dropdown and click Run). This creates all 10 tabs with headers. Safe to re-run.
2. Go to **Deploy > New deployment**
3. Select type: **Web app**
4. Set "Execute as": **Me**
5. Set "Who has access": **Only myself**
6. Click **Deploy**
7. Open the provided URL

### Option B: Browser Only (No Tools Required)

1. Create a new Google Spreadsheet
2. Go to **Extensions > Apps Script** (this creates a container-bound script)
3. In the editor, go to **Project Settings** and check "Show `appsscript.json` manifest file"
4. Replace the contents of `appsscript.json` with the contents of `src/appsscript.json`
5. For each `.gs` file in `src/server/`, create a new script file (File > New > Script) and paste the contents. Name each file to match (e.g., `Main`, `Setup`, etc. -- the `.gs` extension is added automatically)
6. For each `.html` file in `src/client/`, create a new HTML file (File > New > HTML) and paste the contents. Paths matter -- name them exactly:
   - `client/index` (from `src/client/index.html`)
   - `client/css/styles.css` (from `src/client/css/styles.css.html`)
   - `client/js/utils.js` (from `src/client/js/utils.js.html`)
   - `client/js/app.js` (from `src/client/js/app.js.html`)
   - `client/js/hours.js`, `client/js/invoices.js`, `client/js/budget.js`, `client/js/accounts.js`, `client/js/settings.js`
7. Run `setupSheets` from the editor
8. **Deploy > New deployment > Web app** (Execute as: Me, Only myself)

### Updating After Code Changes

Every time you update code (via `clasp push` or manual paste), you must create a **new deployment version** for the changes to take effect:

1. Go to **Deploy > Manage deployments**
2. Click the **pencil icon** (edit) on your deployment
3. Under "Version", select **New version**
4. Click **Deploy**
5. Reload the web app URL

Simply saving the code in the editor is not enough -- the deployed web app serves the version that was active at deployment time.

---

## Usage Guide

### First-Time Setup (After Deployment)

1. **Settings > My Details**: Fill in your name, address, email, phone, tax/GST numbers, bank account, and payment terms. These appear on invoices.
2. **Settings > Businesses**: Add your clients/employers with their contact info, default hourly rate, and currency.
3. **Settings > Work Codes**: Add codes for the types of work you do (e.g., DEV - Development, DESIGN - Design Work, ADMIN - Administration).
4. **Settings > Accounts**: Add your bank, investment, savings, and other accounts you want to track.
5. **Settings > Budget Rules**: Create at least one budget rule with percentages for all 8 categories summing to 100%. Mark one as default.

### Daily Workflow: Logging Hours

1. Go to **Hours > Time Entries**
2. Select a business from the dropdown (rate auto-fills)
3. Select a work code
4. Enter date, start time, end time, and optionally a description
5. Click **Submit** -- hours and line total are calculated automatically

For expenses: switch to the **Expenses** tab, select business and work code, enter date, amount, and description.

### Invoicing

1. Go to **Invoices > Create**
2. Select a business and date range
3. Click **Preview** to see all uninvoiced entries for that period
4. Check/uncheck **Include GST** and adjust the rate if needed
5. Enter any tax already withheld by the payer
6. Click **Create Invoice** to generate. Entries are now marked as invoiced.
7. View the invoice from the **All Invoices** tab. Use your browser's print function for PDF output.
8. Update status as the invoice progresses: **Mark Sent** -> **Mark Paid**

### Budget Allocation

1. Go to **Budget > Allocate**
2. Select a paid invoice and a budget rule
3. Review the allocation preview (gross vs. net breakdown)
4. Adjust "Tax Already Withheld" if needed
5. Click **Allocate** to create the 8 category allocations
6. In **Budget > Summary**, mark allocations as "Transferred" when you move the money, and "Reconciled" when confirmed

### Account Monitoring

1. Go to **Accounts > Monthly**
2. Select a month and click **Load**
3. Enter EOM balance, realised/unrealised gains, tax paid, and notes for each account
4. Click **Save All**
5. Use **Year Overview** to see the full 15-month picture with balance trends

---

## Project Structure

```
MC/
├── .gitignore
├── .clasp.json.example      # Template -- copy to .clasp.json and add your script ID
├── README.md
└── src/
    ├── appsscript.json       # Apps Script manifest (runtime config, webapp settings)
    ├── server/
    │   ├── Main.gs           # doGet() entry point, include() helper
    │   ├── Setup.gs          # Sheet creation (container-bound)
    │   ├── IdService.gs      # Sequential ID generation with LockService
    │   ├── SheetService.gs   # Generic CRUD: getAll, appendRow, updateRow, findById
    │   ├── HoursService.gs   # Time entry and expense logic
    │   ├── InvoiceService.gs # Invoice generation, GST, status tracking
    │   ├── BudgetService.gs  # 8-category budget allocation engine
    │   ├── AccountService.gs # Monthly account summaries, 15-month overview
    │   ├── SettingsService.gs# Reference data CRUD, MyDetails management
    │   └── ClientWrappers.gs # Adapters for google.script.run single-arg limitation
    └── client/
        ├── index.html        # SPA shell with nav, includes all JS/CSS
        ├── css/
        │   └── styles.css.html   # Layout, print, and component styles
        └── js/
            ├── utils.js.html     # serverCall, AppCache, formatters, helpers
            ├── app.js.html       # Hash-based router
            ├── hours.js.html     # Hours & expenses module
            ├── invoices.js.html  # Invoice list, create, preview, detail
            ├── budget.js.html    # Budget allocation & summary
            ├── accounts.js.html  # Monthly entry & year overview
            └── settings.js.html  # All configuration tabs
```

---

## Function Reference

### Client -> Server Call Map

Every server function the client can call, grouped by module. These are invoked via `serverCall('functionName')` which wraps `google.script.run`.

#### Reference Data (loaded on every page via `loadReferenceData`)

| Client calls | Server function | File | Returns |
|-------------|----------------|------|---------|
| `serverCall('getBusinesses')` | `getBusinesses()` | SettingsService.gs | Active businesses |
| `serverCall('getWorkCodes')` | `getWorkCodes()` | SettingsService.gs | Active work codes |
| `serverCall('getAccounts')` | `getAccounts()` | SettingsService.gs | Active accounts |
| `serverCall('getBudgetRules')` | `getBudgetRules()` | SettingsService.gs | All budget rules |
| `serverCall('getMyDetails')` | `getMyDetails()` | SettingsService.gs | Key-value object of invoice details |

#### Hours & Expenses

| Client calls | Server function | File | Purpose |
|-------------|----------------|------|---------|
| `serverCall('addTimeEntry', data)` | `addTimeEntry(data)` | HoursService.gs | Create time entry; calculates hours/total |
| `serverCall('getTimeEntries', filters)` | `getTimeEntries(filters)` | HoursService.gs | Filter entries by business/date/status |
| `serverCall('addExpense', data)` | `addExpense(data)` | HoursService.gs | Create expense entry |
| `serverCall('getExpenses', filters)` | `getExpenses(filters)` | HoursService.gs | Filter expenses |

#### Invoices

| Client calls | Server function | File | Purpose |
|-------------|----------------|------|---------|
| `serverCall('getUninvoicedItems', params)` | `getUninvoicedItems(params)` | ClientWrappers.gs | Preview items for invoicing |
| `serverCall('generateInvoice', params)` | `generateInvoice(params)` | InvoiceService.gs | Create invoice, mark items invoiced |
| `serverCall('getInvoicesWithDetails')` | `getInvoicesWithDetails()` | InvoiceService.gs | List invoices with business names |
| `serverCall('getInvoiceDetails', id)` | `getInvoiceDetails(id)` | InvoiceService.gs | Full invoice detail for viewing |
| `serverCall('updateInvoiceStatusFromClient', params)` | `updateInvoiceStatusFromClient(params)` | ClientWrappers.gs -> `updateInvoiceStatus()` | Change invoice status |

#### Budget

| Client calls | Server function | File | Purpose |
|-------------|----------------|------|---------|
| `serverCall('getBudgetSummary')` | `getBudgetSummary()` | BudgetService.gs | Aggregated budget by category |
| `serverCall('allocateBudgetFromClient', params)` | `allocateBudgetFromClient(params)` | ClientWrappers.gs -> `allocateBudget()` | Create 8 allocations for an invoice |
| `serverCall('updateAllocationStatusFromClient', params)` | `updateAllocationStatusFromClient(params)` | ClientWrappers.gs -> `updateAllocationStatus()` | Mark transferred/reconciled |

#### Accounts

| Client calls | Server function | File | Purpose |
|-------------|----------------|------|---------|
| `serverCall('getAccountSummariesForMonth', month)` | `getAccountSummariesForMonth(month)` | AccountService.gs | Load month's account data |
| `serverCall('saveAccountSummary', data)` | `saveAccountSummary(data)` | AccountService.gs | Save/update monthly snapshot |
| `serverCall('getYearOverview', year)` | `getYearOverview(year)` | AccountService.gs | 15-month overview data |

#### Settings Management

| Client calls | Server function | File | Purpose |
|-------------|----------------|------|---------|
| `serverCall('saveMyDetails', data)` | `saveMyDetails(data)` | SettingsService.gs | Save invoice "From" details |
| `serverCall('addBusiness', data)` | `addBusiness(data)` | SettingsService.gs | Add new business |
| `serverCall('getAllBusinesses')` | `getAllBusinesses()` | SettingsService.gs | List all businesses (inc. inactive) |
| `serverCall('addWorkCode', data)` | `addWorkCode(data)` | SettingsService.gs | Add new work code |
| `serverCall('getAll', 'WorkCodes')` | `getAll('WorkCodes')` | SheetService.gs | List all work codes (inc. inactive) |
| `serverCall('addAccount', data)` | `addAccount(data)` | SettingsService.gs | Add new account |
| `serverCall('getAll', 'Accounts')` | `getAll('Accounts')` | SheetService.gs | List all accounts (inc. inactive) |
| `serverCall('addBudgetRule', data)` | `addBudgetRule(data)` | SettingsService.gs | Add budget rule |
| `serverCall('toggleEntityFromClient', params)` | `toggleEntityFromClient(params)` | ClientWrappers.gs | Activate/deactivate any entity |

### Internal Server Call Chains

How server functions call each other internally:

```
doGet()
└── HtmlService.createTemplateFromFile('client/index')
    └── include() x8  (embeds all JS/CSS files)

generateInvoice(params)
├── getUninvoicedItemsInternal(businessId, dateFrom, dateTo)
│   └── getAll('TimeEntries'), getAll('Expenses')
├── appendRow('Invoices', data)
│   └── generateId('Invoices')  [uses LockService]
├── getSpreadsheet()  [uses SpreadsheetApp.getActiveSpreadsheet()]
└── getColumnIndex(sheet, 'invoice_id')

allocateBudget(invoiceId, ruleId, taxWithheld)
├── findById('Invoices', invoiceId)
│   └── getAll('Invoices')
├── findById('BudgetRules', ruleId)  [or getAll if ruleId is 'default']
├── appendRow('BudgetAllocations', ...) x8
│   └── generateId('BudgetAllocations') x8  [each uses LockService]
└── updateRow('Invoices', ...)

getInvoiceDetails(invoiceId)
├── findById('Invoices', invoiceId)
├── findById('Businesses', businessId)
├── getAll('TimeEntries')  [filtered to invoice]
├── getAll('Expenses')     [filtered to invoice]
├── getAll('BudgetAllocations')  [filtered to invoice]
└── getMyDetails()

getBudgetSummary()
├── getAll('BudgetAllocations')
├── getAll('Invoices')
└── getAll('Businesses')

getYearOverview(year)
├── getAll('AccountSummaries')
└── getActive('Accounts')

setupSheets()
└── getSpreadsheet()
    └── SpreadsheetApp.getActiveSpreadsheet()
```

### ClientWrappers.gs Adapter Pattern

`google.script.run` only supports a single argument per call. Functions that need multiple arguments use `ClientWrappers.gs`, which accepts a pipe-delimited string and splits it:

```
Client:  serverCall('updateInvoiceStatusFromClient', 'INV-2026-001|paid')
Server:  updateInvoiceStatusFromClient('INV-2026-001|paid')
           -> splits on '|'
           -> calls updateInvoiceStatus('INV-2026-001', 'paid')

Client:  serverCall('allocateBudgetFromClient', 'INV-2026-001|RULE-001|500')
Server:  allocateBudgetFromClient('INV-2026-001|RULE-001|500')
           -> splits on '|'
           -> calls allocateBudget('INV-2026-001', 'RULE-001', 500)
```

---

## Troubleshooting

### Stuck on loading spinner

The app loads reference data on every page navigation. If any call hangs:

1. Open browser DevTools (F12 > Console). The app logs every server call with `[serverCall]` prefixes.
2. Look for `TIMEOUT` messages -- these indicate which function isn't responding.
3. Most common cause: **stale deployment**. You updated code but didn't create a new deployment version. See [Updating After Code Changes](#updating-after-code-changes).
4. Second most common: **`setupSheets` wasn't run**, so the sheet tabs don't exist. Run it from the Apps Script editor.

### "Error loading data" message

This means reference data loaded but with errors. Check the console for `[serverCall] FAIL` messages. Usually means:
- Script is not bound to the spreadsheet (it must be created via Extensions > Apps Script from within the spreadsheet)
- Sheet tabs are missing (run `setupSheets`)

### Executions tab errors

In the Apps Script editor, go to **Executions** (left sidebar) to see server-side errors. Common ones:
- `TypeError: Cannot read properties of undefined`: Usually a filter parameter issue. The app guards against this, but check you're on the latest deployment.
- `Exception: You do not have permission`: The script isn't bound to the spreadsheet. Make sure you created it from within the spreadsheet (Extensions > Apps Script), not as a standalone project.

### CSP / Feature-Policy warnings in console

These are normal Google Apps Script warnings (Content Security Policy headers set by Google). They don't affect functionality. Ignore them.

### MutationObserver errors

`TypeError: MutationObserver.observe: Argument 1 is not an object` in `injected.js` -- this is from a **browser extension**, not your app. Ignore it.

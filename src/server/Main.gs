/**
 * Main entry point for the web app.
 * Serves the single-page application.
 */
function doGet(e) {
  var template = HtmlService.createTemplateFromFile('client/index');
  return template.evaluate()
    .setTitle('Finance Tracker')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * Include helper - allows HTML files to include other HTML files.
 * Used as <?!= include('client/css/styles.css') ?> in templates.
 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/**
 * Spreadsheet menu, so migrations can be run without opening the script editor.
 *
 * Schema additions only take effect once setupSheets() runs, and until then
 * writes lose any field whose column does not exist yet. Making that a two-click
 * job is the difference between the migration happening and not.
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Finance Tracker')
    .addItem('Run setup / migrations', 'runSetupFromMenu')
    .addItem('Check for missing columns', 'showSchemaCheck')
    .addToUi();
}

function runSetupFromMenu() {
  var ui = SpreadsheetApp.getUi();
  try {
    setupSheets();
    var remaining = checkSchema();
    ui.alert('Finance Tracker',
      remaining.length === 0
        ? 'Setup complete. All sheets and columns are up to date.'
        : 'Setup ran, but these columns are still missing:\n\n' + describeSchemaWarnings(remaining),
      ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('Finance Tracker', 'Setup failed:\n\n' + (e && e.message ? e.message : String(e)), ui.ButtonSet.OK);
  }
}

function showSchemaCheck() {
  var ui = SpreadsheetApp.getUi();
  var warnings = checkSchema();
  ui.alert('Finance Tracker',
    warnings.length === 0
      ? 'All sheets and columns are up to date.'
      : 'Missing columns — run "Run setup / migrations" to add them:\n\n' + describeSchemaWarnings(warnings),
    ui.ButtonSet.OK);
}

function describeSchemaWarnings(warnings) {
  return warnings.map(function(w) {
    return w.sheet + ': ' + w.missing.join(', ');
  }).join('\n');
}

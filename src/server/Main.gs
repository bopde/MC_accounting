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

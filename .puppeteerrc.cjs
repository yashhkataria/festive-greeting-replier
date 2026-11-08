// The agent drives an installed Chrome/Chromium (CHROME_PATH or Google Chrome
// locally, the system Chromium in Docker), so puppeteer's own download is skipped.
module.exports = { skipDownload: true };

// Renders HTML to a PNG using the Microsoft Edge that ships with Windows (via puppeteer-core).
const puppeteer = require('puppeteer-core');

const EDGE_PATHS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

function launch() {
  const executablePath = EDGE_PATHS.find((p) => require('fs').existsSync(p));
  if (!executablePath) throw new Error('Microsoft Edge not found.');
  return puppeteer.launch({ executablePath, headless: true });
}

// scale 2 gives a sharp image for documents and slides.
async function renderToPng(html, outFile, width, height, scale = 2) {
  const browser = await launch();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: Math.ceil(width), height: Math.ceil(height), deviceScaleFactor: scale });
    await page.setContent(html, { waitUntil: 'load' });
    await page.screenshot({ path: outFile, clip: { x: 0, y: 0, width, height } });
  } finally {
    await browser.close();
  }
}

module.exports = { launch, renderToPng };

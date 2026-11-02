import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Regenerate Chrome's PNG icon assets from the editable Beside artwork.
const assets = new URL('./assets/', import.meta.url);
const svg = await readFile(new URL('beside.svg', assets));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  await page.setContent(`<style>body { margin: 0; } img { display: block; }</style><img src="data:image/svg+xml;base64,${svg.toString('base64')}">`);
  const image = page.locator('img');
  await image.evaluate(image => image.decode());
  for (const size of [16, 32, 48, 128]) {
    await image.evaluate((image, size) => { image.width = size; image.height = size; }, size);
    await image.screenshot({ path: fileURLToPath(new URL(`icon-${size}.png`, assets)), omitBackground: true });
  }
} finally {
  await browser.close();
}

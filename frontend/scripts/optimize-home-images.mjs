// Rebuild the web assets from the original generated PNGs without extra packages.
import { chromium } from '@playwright/test';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const publicDirectory = new URL('../public/images/home/', import.meta.url);
const sourceDirectory = new URL('../design-assets/home/', import.meta.url);
const assets = [
  ['hero-pets', 1600], ['care-corgi', 800], ['category-food', 280],
  ['category-toys', 280], ['category-accessories', 280], ['category-care', 280],
  ['category-supplements', 280],
];
await mkdir(sourceDirectory, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  for (const [name, maxWidth] of assets) {
    const sourceFile = new URL(`${name}.png`, sourceDirectory);
    const publicFile = new URL(`${name}.png`, publicDirectory);
    let bytes;
    try { bytes = await readFile(sourceFile); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      bytes = await readFile(publicFile);
      await rename(publicFile, sourceFile);
    }
    const dataUrl = await page.evaluate(async ({ source, maxWidth }) => {
      const image = new Image();
      image.src = source;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = Math.min(maxWidth, image.naturalWidth);
      canvas.height = Math.round(image.naturalHeight * canvas.width / image.naturalWidth);
      const context = canvas.getContext('2d');
      context.imageSmoothingQuality = 'high';
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/webp', .9);
    }, { source: `data:image/png;base64,${bytes.toString('base64')}`, maxWidth });
    if (!dataUrl.startsWith('data:image/webp;base64,')) throw new Error('Browser WebP encoder unavailable');
    const target = new URL(`${name}.webp`, publicDirectory);
    await writeFile(target, Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log(`${fileURLToPath(target)}: ${(await stat(target)).size} bytes`);
  }
} finally {
  await browser.close();
}

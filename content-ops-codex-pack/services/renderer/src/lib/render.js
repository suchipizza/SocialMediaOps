import { chromium } from "playwright";

/**
 * Render a set of slides from HTML into images.
 * @param {Object} params
 * @param {string[]} params.slideHtml Array of per-slide HTML strings.
 * @param {{width:number,height:number,format:'jpeg'|'png',quality:number}} params.output
 * @returns {Promise<Buffer[]>} Image buffers in order.
 */
export async function renderSlides({ slideHtml, output }) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: output.width, height: output.height } });

  const buffers = [];
  for (const html of slideHtml) {
    await page.setContent(html, { waitUntil: "load" });
    const buf = await page.screenshot({ type: output.format, quality: output.format === "jpeg" ? output.quality : undefined, fullPage: false });
    buffers.push(buf);
  }

  await browser.close();
  return buffers;
}

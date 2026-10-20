import { readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
// Renders docs/diagrams/<name>.mmd to docs/images/<name>.png.
// Usage: npm install --no-save mermaid@11 && node docs/diagrams/render.mjs mindmap task-flow architecture
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '..', 'images'); mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 2, viewport: { width: 1600, height: 1200 } });
await page.setContent('<html><body style="margin:0;background:#fff"><div id="c" style="display:inline-block;padding:24px;background:#fff"></div></body></html>');
await page.addScriptTag({ path: createRequire(import.meta.url).resolve('mermaid/dist/mermaid.min.js') });
for (const name of process.argv.slice(2)) {
  const src = readFileSync(path.join(here, name + '.mmd'), 'utf8');
  await page.evaluate(async ({ src, name }) => {
    mermaid.initialize({ startOnLoad: false, theme: 'base', fontFamily: 'Inter, Segoe UI, Helvetica, Arial, sans-serif',
      themeVariables: { fontSize: '20px', cScale0: '#ffe7b3', cScale1: '#c9f0d3', cScale2: '#d9d2ff', cScale3: '#f6d5f0', cScaleLabel0: '#3b2f00', cScaleLabel1: '#0d3b1c', cScaleLabel2: '#231a5c', cScaleLabel3: '#4a1240', cScaleInv0: '#d9a400', cScaleInv1: '#2f9e4f', cScaleInv2: '#6a5acd', cScaleInv3: '#b5479a',  primaryColor: '#e8f1ff', primaryBorderColor: '#3b74d9', lineColor: '#5b6b85', primaryTextColor: '#0b2350' },
      flowchart: { curve: 'basis', padding: 14, nodeSpacing: 40, rankSpacing: 50 }, mindmap: { padding: 14 } });
    const { svg } = await mermaid.render('d_' + name.replace(/-/g, '_'), src);
    document.getElementById('c').innerHTML = svg;
    const el = document.querySelector('#c svg');
    const vb = el.viewBox.baseVal;
    el.style.maxWidth = 'none';
    el.setAttribute('width', String(Math.round(vb.width)));
    el.setAttribute('height', String(Math.round(vb.height)));
  }, { src, name });
  await page.locator('#c').screenshot({ path: path.join(out, name + '.png') });
  console.log('rendered', name);
}
await browser.close();

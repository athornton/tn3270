// Electron main for render-icon.mjs: `<svg> <out.png>=<size>...`. Draws the SVG offscreen at
// each size, refuses a capture of any other size, writes the PNGs, quits.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');

const at = process.argv.findIndex((a) => a.endsWith('.svg'));
const svgPath = process.argv[at];
const jobs = process.argv.slice(at + 1).map((j) => {
  const m = /^(.*)=(\d+)$/.exec(j);
  if (!m) throw new Error(`renderIconMain: bad job ${j}`);
  return { out: m[1], size: Number(m[2]) };
});
const svg = Buffer.from(fs.readFileSync(svgPath)).toString('base64');

app.disableHardwareAcceleration();
// Each job destroys its window, and Electron's default on the last close is to QUIT WITH STATUS 0:
// measured 2026-11-08, the first PNG was written and the rest silently were not.
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  for (const { out, size } of jobs) {
    const w = new BrowserWindow({
      width: size, height: size, useContentSize: true, show: false, frame: false, transparent: true,
      webPreferences: { offscreen: true },
    });
    const html = '<html><body style="margin:0;background:transparent">'
      + `<img id="i" src="data:image/svg+xml;base64,${svg}" width="${size}" height="${size}"></body></html>`;
    await w.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`);
    await w.webContents.executeJavaScript('document.getElementById("i").decode()');
    const img = await w.webContents.capturePage();
    const got = img.getSize();
    if (got.width !== size || got.height !== size) {
      throw new Error(`renderIconMain: captured ${got.width}x${got.height} for ${out}, wanted ${size}x${size}`);
    }
    fs.writeFileSync(out, img.toPNG());
    w.destroy();
  }
  app.quit();
}).catch((e) => { console.error(e); app.exit(1); });

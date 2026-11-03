// Prints the OS clipboard as one JSON line, from its own Electron main process. The page under test
// has no clipboard API (that is the point of the check), so it cannot read its own result back.
// AWAITED: clipboard.readText() returns a Promise in Electron 44, and an unawaited one prints {}.
const { app, clipboard } = require('electron');
app.whenReady().then(async () => {
  process.stdout.write(`CLIP=${JSON.stringify(await clipboard.readText())}\n`);
  app.exit(0);
});

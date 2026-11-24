import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('tn3270about', {
  /** Main sends the whole About text on open, on each connection change and once a second. */
  onText: (cb: (text: string) => void): void => {
    ipcRenderer.on('about:text', (_e, text: string) => { cb(text); });
  },
  /** Copy the text main last sent, done in main so it is exactly what is shown. */
  copy: (): void => { ipcRenderer.send('about:copy'); },
});

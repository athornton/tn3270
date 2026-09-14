import { contextBridge, ipcRenderer } from 'electron';

/**
 * The ONLY bridge between the protocol and the canvas: frames down, actions up.
 *
 * `contextIsolation` is on and `nodeIntegration` off, so the renderer cannot reach a socket
 * even if it tried. That is not ceremony -- the renderer parses nothing and owns no protocol
 * state, so a compromise there costs a repaint. Widening this surface is what would change
 * that, which is why it is two functions and not an object graph.
 */
contextBridge.exposeInMainWorld('tn3270', {
  /** Receive a frame: the raw snapshot plus its resolved attributes. */
  onFrame: (fn: (frame: unknown) => void) => {
    ipcRenderer.on('frame', (_e, frame) => { fn(frame); });
  },
  /** Receive a message to show instead of a screen (connect and TLS failures). */
  onError: (fn: (message: string) => void) => {
    ipcRenderer.on('error-message', (_e, message: string) => { fn(message); });
  },
  /** Send one named 3270 action up to the session. */
  sendAction: (action: unknown) => { ipcRenderer.send('action', action); },
});

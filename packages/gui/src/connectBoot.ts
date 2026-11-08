/**
 * The startup Connect dialog's page: real elements in, the preload's bridge out.
 *
 * DELIBERATELY THIN, the same split as `transferBoot.ts`: there is no `document` under vitest, so
 * every decision about what the form MEANS lives in main -- `submitConnect` in `connectDialog.ts`,
 * which runs the real `parseGuiArgs`. This file only reads controls, shows the answer and moves
 * focus. It imports NOTHING, so `connect.html` needs no import map and the bundle no graph.
 */
declare global {
  interface Window {
    tn3270connect?: {
      models(): Promise<{ models: readonly string[]; default: string }>;
      submit(form: { host: string; model: string; tls: boolean }):
        Promise<{ ok?: true; error?: string; modelLocked?: boolean }>;
      quit(): void;
    };
  }
}

const bridge = window.tn3270connect;
const form = document.querySelector<HTMLFormElement>('#connect-form');
const host = document.querySelector<HTMLInputElement>('#host');
const model = document.querySelector<HTMLSelectElement>('#model');
const tls = document.querySelector<HTMLInputElement>('#tls');
const connect = document.querySelector<HTMLButtonElement>('#connect');
const quit = document.querySelector<HTMLButtonElement>('#quit');
const error = document.querySelector<HTMLDivElement>('#connect-error');
if (form === null || host === null || model === null || tls === null || connect === null
  || quit === null || error === null) {
  throw new Error('connect.html is missing one of its controls');
}
if (bridge === undefined) {
  throw new Error('connect window: the tn3270connect bridge is absent (preload failed to load?)');
}

/**
 * DISABLED UNTIL THE MODELS ARRIVE, and while a submit is in flight. An empty dropdown would submit
 * `model: ''`, and two submits in flight would race main's one-time session start.
 */
let busy = true;
const setBusy = (b: boolean): void => {
  busy = b;
  connect.disabled = b;
};
setBusy(true);

void bridge.models().then(({ models, default: chosen }) => {
  for (const m of models) {
    const o = document.createElement('option');
    o.value = m;
    o.textContent = m;
    if (m === chosen) o.selected = true;
    model.append(o);
  }
  setBusy(false);
}, (err: unknown) => {
  error.textContent = `could not list the models: ${String(err)}`;
});

/**
 * ENTER IS THE FORM'S OWN SUBMIT: Connect is the form's `type="submit"` button, so Enter in the
 * Host field submits through this listener exactly as a click does -- one path, not two.
 */
form.addEventListener('submit', (e) => {
  e.preventDefault();
  // ONE SUBMIT IN FLIGHT. Main refuses a second start too; this keeps the page from asking.
  if (busy) return;
  setBusy(true);
  error.textContent = '';
  bridge.submit({ host: host.value, model: model.value, tls: tls.checked }).then((r) => {
    if (r.ok === true) return;          // main closes this window and starts the session
    error.textContent = r.error ?? 'refused, with no reason given';
    setBusy(false);
    host.focus();
    host.select();
  }, (err: unknown) => {
    error.textContent = String(err);
    setBusy(false);
    host.focus();
  });
});

quit.addEventListener('click', () => { bridge.quit(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    bridge.quit();
  }
});

host.focus();

export {};

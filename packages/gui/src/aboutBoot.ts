declare global {
  interface Window {
    tn3270about?: { onText(cb: (text: string) => void): void; copy(): void };
  }
}

const bridge = window.tn3270about;
const pre = document.getElementById('about-text');
if (bridge !== undefined && pre !== null) {
  bridge.onText((text) => { pre.textContent = text; });
  document.getElementById('copy')?.addEventListener('click', () => { bridge.copy(); });
}

export {};

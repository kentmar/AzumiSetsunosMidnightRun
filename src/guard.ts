// Domain lock: a production build only runs on the hosts baked in at build
// time (ALLOWED_HOSTS + Railway's public domain, see vite.config.ts), so a
// straight re-upload of dist/ to another site shows a notice instead of the
// game. Also refuses to run framed by a foreign page. Dev builds are unlocked.
// Deterrent only — anyone determined can patch it out of the bundle.

declare const __ALLOWED_HOSTS__: string[];

const LOCAL = ['localhost', '127.0.0.1', '[::1]'];

function hostOk(host: string): boolean {
  host = host.toLowerCase();
  if (LOCAL.includes(host)) return true;
  // "example.com" also covers "www.example.com"
  return __ALLOWED_HOSTS__.some((h) => host === h || host.endsWith('.' + h));
}

function framedByForeignPage(): boolean {
  if (window.top === window.self) return false;
  const anc = location.ancestorOrigins;
  if (anc && anc.length) {
    for (let i = 0; i < anc.length; i++) {
      try { if (!hostOk(new URL(anc[i]).hostname)) return true; } catch { return true; }
    }
    return false;
  }
  try { return !hostOk(new URL(document.referrer).hostname); } catch { return true; }
}

/** true if the game may boot here; otherwise paints a notice and returns false */
export function domainAllowed(): boolean {
  if (import.meta.env.DEV || !__ALLOWED_HOSTS__.length) return true;
  if (hostOk(location.hostname) && !framedByForeignPage()) return true;

  const home = __ALLOWED_HOSTS__[0];
  const app = document.getElementById('app')!;
  app.innerHTML = '';
  const box = document.createElement('div');
  box.style.cssText =
    'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;' +
    'gap:14px;color:#ffb347;letter-spacing:3px;text-align:center;padding:16px;';
  const h = document.createElement('div');
  h.style.cssText = 'font-size:28px;font-weight:700;';
  h.textContent = 'NIGHT RUN: NYC';
  const p = document.createElement('div');
  p.style.cssText = 'font-size:14px;color:#58e6ff;';
  p.textContent = 'This copy is not authorized. Play the official version at';
  const a = document.createElement('a');
  a.href = 'https://' + home;
  a.target = '_top';
  a.textContent = home;
  a.style.cssText = 'color:#ffb347;font-size:16px;';
  box.append(h, p, a);
  app.appendChild(box);
  return false;
}

// Экран «Настройки».
import { prefs, setPref } from '../prefs.js';
import { db } from '../store.js';
import { byId, toast } from './dom.js';

export const APK_URL = 'https://github.com/TERMINATOOOOOOOr/chess-coach/releases/latest/download/shoh.apk';

export function initSettings({ onUsernameChange }) {
  const name = byId('set-name');
  name.value = prefs.username;
  byId('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = name.value.trim();
    if (v === prefs.username) return;
    await setPref('username', v);
    toast(v ? `Ник сохранён: ${v}` : 'Ник удалён');
    onUsernameChange(v);
  });
  for (const r of document.querySelectorAll('input[name="set-mode"]')) {
    r.checked = r.value === prefs.mode;
    r.addEventListener('change', () => r.checked && setPref('mode', r.value));
  }
  for (const [id, key] of [['set-autosync', 'autosync'], ['set-autoreview', 'autoreview']]) {
    const el = byId(id);
    el.checked = !!prefs[key];
    el.addEventListener('change', () => setPref(key, el.checked));
  }
  // внутри APK ссылка на APK не нужна
  const inApp = !!window.Capacitor;
  byId('apk-row').hidden = inApp;
  byId('apk-link').href = APK_URL;

  let armed = null;
  byId('btn-wipe').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (!armed) {
      btn.textContent = 'Точно удалить все партии?';
      btn.classList.add('confirm');
      armed = setTimeout(() => {
        armed = null;
        btn.textContent = 'Удалить партии с телефона';
        btn.classList.remove('confirm');
      }, 3000);
      return;
    }
    clearTimeout(armed);
    armed = null;
    for (const g of await db.allGames()) await db.deleteGame(g.id);
    btn.textContent = 'Удалить партии с телефона';
    btn.classList.remove('confirm');
    toast('Партии удалены с устройства');
  });
}

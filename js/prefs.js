// Настройки приложения (на устройстве).
import { db } from './store.js';
import { normalizeUsername } from './chesscom.js';

export const prefs = {
  username: '',
  mode: 'accurate', // fast | accurate — глубина разбора партий
  autosync: true, // проверять новые партии при запуске
  autoreview: true, // сразу разбирать новые партии
};

export async function loadPrefs() {
  for (const k of Object.keys(prefs)) prefs[k] = await db.getSetting(k, prefs[k]);
  // раньше в поле ника могла сохраниться ссылка на профиль — превращаем её в ник
  if (prefs.username) {
    try {
      const nick = normalizeUsername(prefs.username);
      if (nick !== prefs.username) await setPref('username', nick);
    } catch {
      /* оставляем как есть — при синхронизации будет понятная ошибка */
    }
  }
  return prefs;
}

export async function setPref(k, v) {
  prefs[k] = v;
  await db.setSetting(k, v);
}

// Настройки приложения (на устройстве).
import { db } from './store.js';

export const prefs = {
  username: '',
  mode: 'accurate', // fast | accurate — глубина разбора партий
  autosync: true, // проверять новые партии при запуске
  autoreview: true, // сразу разбирать новые партии
};

export async function loadPrefs() {
  for (const k of Object.keys(prefs)) prefs[k] = await db.getSetting(k, prefs[k]);
  return prefs;
}

export async function setPref(k, v) {
  prefs[k] = v;
  await db.setSetting(k, v);
}

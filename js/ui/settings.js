// Экран «Настройки».
import { prefs, setPref } from '../prefs.js';
import { normalizeUsername } from '../chesscom.js';
import { db } from '../store.js';
import { updateState, checkForUpdate, updatesSupported, runningVersion } from '../updater.js';
import { byId, toast, on } from './dom.js';

export const APK_URL = 'https://github.com/TERMINATOOOOOOOr/chess-coach/releases/latest/download/shoh.apk';

const fmtBuilt = (ts) =>
  new Date(ts * 1000).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Версия сайта из <meta>, которую вписывает tools/build_site.py (в разработке её нет). */
function webVersion() {
  const m = document.querySelector('meta[name="shoh-version"]');
  return m ? { version: m.content, built: +m.dataset.built } : null;
}

/** Блок «Обновления»: версия, статус живого обновления APK, кнопка «Проверить». */
async function initUpdates() {
  const native = updatesSupported();
  const v = native ? await runningVersion() : webVersion();
  if (!v) return; // разработка и однофайловая версия для компьютера — без версии
  byId('updates-card').hidden = false;
  byId('btn-upd-check').hidden = !native;
  byId('upd-apk-link').href = APK_URL;
  let toastedReady = false;
  let toastedApk = false;
  const render = () => {
    const running = updateState.running || v;
    byId('upd-version').textContent = `Версия от ${fmtBuilt(running.built)}`;
    let text = '';
    let cls = '';
    if (!native) text = 'Обновляется автоматически при открытии.';
    else {
      const st = updateState.status;
      if (st === 'checking') text = 'Проверяю обновления…';
      else if (st === 'downloading') text = `Скачиваю обновление… ${Math.round(updateState.progress * 100)}%`;
      else if (st === 'ready') [text, cls] = ['Обновление скачано — включится при следующем запуске Shoh.', 'ok'];
      else if (st === 'latest') [text, cls] = [updateState.justUpdated ? 'Shoh только что обновился — это последняя версия.' : 'Установлена последняя версия.', 'ok'];
      else if (st === 'need-apk') [text, cls] = ['Вышла версия, которой нужна новая сборка приложения.', 'warn'];
      else if (st === 'error') [text, cls] = [`Не получилось проверить: ${updateState.error}`, 'error'];
    }
    const s = byId('upd-status');
    s.textContent = text;
    s.className = `upd-status ${cls}`;
    byId('upd-apk-row').hidden = updateState.status !== 'need-apk';
    byId('btn-upd-check').disabled = ['checking', 'downloading'].includes(updateState.status);
  };
  render();
  on('update-status', (st) => {
    render();
    if (st.status === 'ready' && !st.manual && !toastedReady) {
      toastedReady = true;
      toast('Обновление Shoh скачано — включится при следующем запуске.');
    }
    if (st.status === 'need-apk' && !toastedApk) {
      toastedApk = true;
      toast('Вышла новая версия Shoh — скачай APK в «Настройках».');
    }
    if (st.justUpdated && st.status === 'latest' && !st.toasted) {
      st.toasted = true;
      toast(`Shoh обновился: версия от ${fmtBuilt(st.running.built)}.`);
    }
  });
  byId('btn-upd-check').addEventListener('click', () => checkForUpdate({ manual: true }));
}

export function initSettings({ onUsernameChange }) {
  initUpdates();
  const name = byId('set-name');
  name.value = prefs.username;
  byId('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    let v;
    try {
      v = normalizeUsername(name.value);
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
    name.value = v;
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
  byId('pwa-hint').hidden = inApp;
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

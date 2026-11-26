// Живые обновления веб-части внутри APK (Capacitor), как у игр из магазина:
//   1) при запуске тихо сверяемся с version.json на GitHub Pages;
//   2) скачиваем только изменившиеся файлы, каждый проверяем по sha256, кладём в папку www-<версия>;
//   3) при следующем запуске переключаемся на неё (WebView.setServerBasePath);
//   4) новая версия, успешно запустившись, закрепляет себя (persistServerBasePath).
// Если новая версия не дошла до подтверждения, переключение не закреплено и следующий запуск
// вернётся к прежней; после двух неудач версия помечается плохой. На сайте и в однофайловой
// версии модуль ничего не делает: там обновляет service worker.
import { emit } from './ui/dom.js';

export const UPDATE_BASE = 'https://terminatooooooor.github.io/chess-coach/';
const KEYS = { ready: 'shoh.update.ready', trying: 'shoh.update.trying', bad: 'shoh.update.bad' };
const MAX_TRIES = 2;

// ───────────────────────── чистые функции ─────────────────────────

/** Удалённая версия новее запущенной. */
export function isNewer(remote, local) {
  return !!(remote && local && remote.version && remote.version !== local.version && (remote.built || 0) > (local.built || 0));
}

/** Каких нативных плагинов не хватает для этой версии (тогда нужен новый APK). */
export function missingPlugins(remote, isAvailable) {
  return (remote.requires || []).filter((n) => !isAvailable(n));
}

/**
 * Что скачать, а что скопировать с устройства. HTML всегда качаем:
 * Capacitor встраивает в отдаваемый index.html свой скрипт, и копия не совпала бы по sha.
 */
export function planFiles(remote, local) {
  const download = [];
  const copy = [];
  for (const [path, sha] of Object.entries(remote.files || {})) {
    if (!path.endsWith('.html') && local && local.files && local.files[path] === sha) copy.push(path);
    else download.push(path);
  }
  return { download, copy };
}

/** Решение при запуске: переключиться, подтвердить, выбросить устаревшее или пометить плохим. */
export function decideOnBoot({ ready, trying, bad = [] }, running) {
  if (!running) return { action: 'none' };
  if (trying && trying.version === running.version) return { action: 'confirm' };
  if (!ready) return { action: 'none' };
  if (bad.includes(ready.version) || !isNewer(ready, running)) return { action: 'drop' };
  const tries = trying && trying.version === ready.version ? trying.count : 0;
  if (tries >= MAX_TRIES) return { action: 'mark-bad' };
  return { action: 'switch', tries: tries + 1 };
}

export async function sha256Hex(buf) {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function toBase64(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// ───────────────────────── работа в APK ─────────────────────────

const cap = () => {
  const c = typeof window !== 'undefined' ? window.Capacitor : null;
  return c && typeof c.isNativePlatform === 'function' && c.isNativePlatform() ? c : null;
};
const plugin = (name) => {
  const c = cap();
  if (!c) return null;
  return (c.Plugins && c.Plugins[name]) || (c.registerPlugin ? c.registerPlugin(name) : null);
};

/** Есть ли в установленном APK всё нужное для живых обновлений. */
export const updatesSupported = () => {
  const c = cap();
  return !!c && ['Filesystem', 'Preferences', 'WebView'].every((n) => c.isPluginAvailable(n));
};

/** Текущее состояние — для экрана настроек. */
export const updateState = { running: null, status: 'idle', remote: null, error: null, progress: 0, justUpdated: false };

function setStatus(status, extra = {}) {
  Object.assign(updateState, { status }, extra);
  emit('update-status', updateState);
}

async function prefGet(key) {
  const r = await plugin('Preferences').get({ key });
  return r && r.value ? JSON.parse(r.value) : null;
}
const prefSet = (key, v) => plugin('Preferences').set({ key, value: JSON.stringify(v) });
const prefDel = (key) => plugin('Preferences').remove({ key });

async function readLocalManifest() {
  try {
    const r = await fetch('./version.json', { cache: 'no-store' });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

/** Версия, которая сейчас запущена (на сайте тоже, для показа в настройках). */
export async function runningVersion() {
  if (!updateState.running) updateState.running = await readLocalManifest();
  return updateState.running;
}

/** Первым делом при запуске. 'switching' — приложение уже перезагружается в новую версию. */
export async function updaterBoot() {
  if (!updatesSupported()) return 'off';
  const running = await runningVersion();
  if (!running) return 'off';
  const st = { ready: await prefGet(KEYS.ready), trying: await prefGet(KEYS.trying), bad: (await prefGet(KEYS.bad)) || [] };
  const d = decideOnBoot(st, running);
  if (d.action === 'switch') {
    await prefSet(KEYS.trying, { version: st.ready.version, count: d.tries });
    await plugin('WebView').setServerBasePath({ path: st.ready.dir });
    return 'switching';
  }
  if (d.action === 'mark-bad') {
    await prefSet(KEYS.bad, [...st.bad, st.ready.version].slice(-10));
    await prefDel(KEYS.ready);
    await prefDel(KEYS.trying);
  } else if (d.action === 'drop') {
    await prefDel(KEYS.ready);
  }
  updateState.pendingConfirm = d.action === 'confirm';
  return d.action;
}

/** Приложение запустилось без ошибок: закрепляем версию, чистим старые папки. */
export async function confirmBoot() {
  if (!updateState.pendingConfirm) return;
  updateState.pendingConfirm = false;
  const W = plugin('WebView');
  await W.persistServerBasePath();
  await prefDel(KEYS.trying);
  await prefDel(KEYS.ready);
  setStatus('latest', { justUpdated: true });
  try {
    await cleanup((await W.getServerBasePath()).path);
  } catch {
    /* не критично */
  }
}

async function cleanup(currentPath) {
  const FS = plugin('Filesystem');
  const { files } = await FS.readdir({ path: '', directory: 'DATA' });
  const keep = new Set([currentPath ? currentPath.split('/').filter(Boolean).pop() : null]);
  const ready = await prefGet(KEYS.ready);
  if (ready) keep.add(ready.dir.split('/').filter(Boolean).pop());
  for (const f of files || []) {
    const name = typeof f === 'string' ? f : f.name;
    if (name && name.startsWith('www-') && !keep.has(name)) await FS.rmdir({ path: name, directory: 'DATA', recursive: true });
  }
}

let checking = null;
/** Проверить и, если есть, скачать обновление. manual — нажали кнопку (показываем ошибки). */
export function checkForUpdate({ manual = false } = {}) {
  if (!checking) checking = doCheck(manual).finally(() => (checking = null));
  return checking;
}

async function doCheck(manual) {
  if (!updatesSupported() || !(await runningVersion())) return;
  setStatus('checking', { error: null });
  try {
    const r = await fetch(`${UPDATE_BASE}version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`сервер обновлений ответил ${r.status}`);
    const remote = await r.json();
    updateState.remote = remote;
    if (!isNewer(remote, updateState.running)) return setStatus('latest');
    if (((await prefGet(KEYS.bad)) || []).includes(remote.version)) return setStatus('latest');
    const ready = await prefGet(KEYS.ready);
    if (ready && ready.version === remote.version) return setStatus('ready');
    if (missingPlugins(remote, (n) => cap().isPluginAvailable(n)).length) return setStatus('need-apk');
    await download(remote);
    setStatus('ready', { manual });
  } catch (e) {
    setStatus(manual ? 'error' : 'idle', { error: e instanceof TypeError ? 'нет связи с сервером обновлений' : e.message });
  }
}

async function download(remote) {
  const FS = plugin('Filesystem');
  const dir = `www-${remote.version}`;
  const { download: dl, copy } = planFiles(remote, updateState.running);
  const all = [...copy.map((p) => [p, true]), ...dl.map((p) => [p, false])];
  let done = 0;
  for (const [path, local] of all) {
    const url = local ? `./${path}` : `${UPDATE_BASE}${path}?v=${remote.version}`;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`не скачался ${path} (${res.status})`);
    const buf = await res.arrayBuffer();
    if ((await sha256Hex(buf)) !== remote.files[path]) throw new Error(`файл ${path} пришёл повреждённым`);
    await FS.writeFile({ path: `${dir}/${path}`, data: toBase64(buf), directory: 'DATA', recursive: true });
    done++;
    setStatus('downloading', { progress: done / all.length });
  }
  await FS.writeFile({
    path: `${dir}/version.json`,
    data: toBase64(new TextEncoder().encode(JSON.stringify(remote))),
    directory: 'DATA',
    recursive: true,
  });
  const { uri } = await FS.getUri({ path: dir, directory: 'DATA' });
  const path = decodeURIComponent(uri.replace(/^file:\/\//, ''));
  await prefSet(KEYS.ready, { version: remote.version, built: remote.built, dir: path });
  updateState.downloaded = { download: dl.length, copy: copy.length };
}

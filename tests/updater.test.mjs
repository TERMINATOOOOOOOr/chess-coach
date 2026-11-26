import test from 'node:test';
import assert from 'node:assert/strict';
import { isNewer, missingPlugins, planFiles, decideOnBoot, sha256Hex, toBase64 } from '../js/updater.js';

const v1 = { version: 'aaa', built: 100, files: { 'index.html': 'h1', 'vendor/stockfish.js': 's1', 'js/app.js': 'a1' } };
const v2 = { version: 'bbb', built: 200, files: { 'index.html': 'h2', 'vendor/stockfish.js': 's1', 'js/app.js': 'a2', 'js/new.js': 'n1' }, requires: ['Filesystem', 'Preferences'] };

test('новее: другая версия и сборка позже', () => {
  assert.equal(isNewer(v2, v1), true);
  assert.equal(isNewer(v1, v2), false); // старее
  assert.equal(isNewer({ ...v1, built: 300 }, v1), false); // та же версия, пересобрана
  assert.equal(isNewer(null, v1), false);
});

test('нужен новый APK, если не хватает нативного плагина', () => {
  assert.deepEqual(missingPlugins(v2, (n) => n !== 'Preferences'), ['Preferences']);
  assert.deepEqual(missingPlugins(v2, () => true), []);
  assert.deepEqual(missingPlugins(v1, () => false), []);
});

test('качаем только изменённое; Stockfish копируем; HTML всегда качаем', () => {
  const { download, copy } = planFiles(v2, v1);
  assert.deepEqual(copy, ['vendor/stockfish.js']);
  assert.deepEqual(download.sort(), ['index.html', 'js/app.js', 'js/new.js']);
  const same = planFiles(v1, v1);
  assert.ok(same.download.includes('index.html'), 'HTML с устройства отдаётся с вставкой Capacitor — качаем заново');
});

test('при запуске: переключиться на скачанную версию', () => {
  const ready = { version: 'bbb', built: 200, dir: '/data/files/www-bbb' };
  assert.deepEqual(decideOnBoot({ ready }, v1), { action: 'switch', tries: 1 });
  // уже пробовали один раз и вернулись на старую — пробуем ещё раз
  assert.deepEqual(decideOnBoot({ ready, trying: { version: 'bbb', count: 1 } }, v1), { action: 'switch', tries: 2 });
});

test('новая версия запустилась — подтвердить', () => {
  const ready = { version: 'bbb', built: 200, dir: '/x' };
  assert.deepEqual(decideOnBoot({ ready, trying: { version: 'bbb', count: 1 } }, v2), { action: 'confirm' });
});

test('две неудачи — версия плохая, больше не ставим', () => {
  const ready = { version: 'bbb', built: 200, dir: '/x' };
  assert.deepEqual(decideOnBoot({ ready, trying: { version: 'bbb', count: 2 } }, v1), { action: 'mark-bad' });
  assert.deepEqual(decideOnBoot({ ready, bad: ['bbb'] }, v1), { action: 'drop' });
});

test('скачанное устарело (например, поставили новый APK) — выбросить', () => {
  const ready = { version: 'bbb', built: 200, dir: '/x' };
  const apk = { version: 'ccc', built: 300, files: {} };
  assert.deepEqual(decideOnBoot({ ready }, apk), { action: 'drop' });
  assert.deepEqual(decideOnBoot({}, apk), { action: 'none' });
});

test('sha256 и base64 для записи файлов', async () => {
  const buf = new TextEncoder().encode('шахматы');
  assert.equal(await sha256Hex(buf), 'c772e7e0892f6046ec2352ffa9c7179d765156eda7de43ffd984bea54cbe8bf6');
  assert.equal(Buffer.from(toBase64(buf), 'base64').toString('utf8'), 'шахматы');
  const big = new Uint8Array(200000).map((_, i) => i % 251);
  assert.deepEqual(new Uint8Array(Buffer.from(toBase64(big), 'base64')), big);
});

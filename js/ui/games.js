// Экран «Партии»: синхронизация с chess.com, ручное добавление, список с прогрессом разбора.
import {
  fetchRecentGames, findLinkedGame, gameFromPgn, parseShared, formatTimeControl, timeClassName, normalizeUsername,
} from '../chesscom.js';
import { db } from '../store.js';
import { prefs, setPref } from '../prefs.js';
import { enqueueReview, reviewProgress, isReviewed, reviewingId } from '../reviewer.js';
import { byId, h, on, toast, formatDate } from './dom.js';
import { navigate, currentScreen } from './tabs.js';

const RESULT = { win: 'Победа', loss: 'Поражение', draw: 'Ничья', white: '1–0', black: '0–1', unknown: '—' };
let syncing = false;

export function opponentOf(g) {
  if (g.myColor === 'w') return { name: g.black, elo: g.blackElo, myElo: g.whiteElo };
  if (g.myColor === 'b') return { name: g.white, elo: g.whiteElo, myElo: g.blackElo };
  return null;
}

function setStatus(text, kind = '') {
  const s = byId('sync-status');
  s.textContent = text || '';
  s.className = `sync-status ${kind}`;
}

/** Подтянуть новые партии с chess.com. */
export async function syncGames() {
  if (!prefs.username || syncing) return;
  syncing = true;
  byId('btn-sync').classList.add('spinning');
  setStatus(`Проверяю партии ${prefs.username} на chess.com…`);
  try {
    const remote = await fetchRecentGames(prefs.username, { months: 2, limit: 30 });
    const existing = new Set((await db.allGames()).map((g) => g.id));
    const fresh = remote.filter((g) => !existing.has(g.id));
    for (const g of fresh) await db.putGame({ ...g, addedAt: Date.now() });
    if (prefs.autoreview) fresh.slice(0, 5).forEach((g) => enqueueReview(g.id));
    setStatus(
      fresh.length
        ? `Новых партий: ${fresh.length}.${prefs.autoreview ? ' Тренер уже разбирает свежие.' : ''}`
        : 'Новых законченных партий нет.',
    );
  } catch (e) {
    // TypeError у fetch — это и обрыв сети, и ответ chess.com без CORS (например, на неверный ник)
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    let msg = e.message;
    if (e instanceof TypeError) {
      msg = offline
        ? 'Нет интернета — партии подтянутся, когда появится связь.'
        : `chess.com не ответил на запрос по нику «${prefs.username}». Проверь ник в настройках или попробуй позже.`;
    }
    setStatus(msg, 'error');
  } finally {
    syncing = false;
    byId('btn-sync').classList.remove('spinning');
    renderGames();
  }
}

/** Принять ссылку/PGN (кнопка «Поделиться» или ручная вставка). Возвращает партию. */
export async function importShared(text) {
  const p = parseShared(text);
  if (!p) throw new Error('Не вижу здесь ни ссылки на партию chess.com, ни PGN.');
  let g;
  if (p.type === 'pgn') {
    g = gameFromPgn(p.pgn, prefs.username);
  } else {
    const known = (await db.allGames()).find((x) => x.id.endsWith('-' + p.gameId));
    if (known) return known;
    if (!prefs.username) {
      throw new Error('Чтобы открыть партию по ссылке, укажи свой ник chess.com в настройках. Или пришли PGN.');
    }
    g = await findLinkedGame(prefs.username, p.gameId);
    if (!g) {
      throw new Error('Эта партия не нашлась среди твоих законченных партий за 2 месяца. Пришли её PGN: в chess.com «Поделиться» → PGN.');
    }
  }
  const old = await db.getGame(g.id);
  if (old) return old;
  g.addedAt = Date.now();
  await db.putGame(g);
  return g;
}

function statusNode(g) {
  if (isReviewed(g)) {
    const side = g.myColor ? g.review.sides[g.myColor] : g.review.sides.w;
    const acc = side.accuracy == null ? '—' : Math.round(side.accuracy);
    const bad = side.counts.blunder + side.counts.mistake;
    return h('div.gstat',
      h('span.acc', { style: { '--p': acc === '—' ? 0 : acc } }, h('b', {}, String(acc)), h('small', {}, '%')),
      h('small.gbad', {}, bad ? `${bad} ${bad === 1 ? 'ошибка' : bad < 5 ? 'ошибки' : 'ошибок'}` : 'без ошибок'));
  }
  if (reviewProgress.has(g.id)) {
    const p = reviewProgress.get(g.id) || 0;
    const active = reviewingId() === g.id;
    return h('div.gstat.pending',
      h('div.minibar', {}, h('i', { style: { width: `${Math.round(p * 100)}%` } })),
      h('small', {}, active ? `разбор ${Math.round(p * 100)}%` : 'в очереди'));
  }
  if (g.reviewError) return h('div.gstat', h('small.gbad', {}, 'ошибка разбора'));
  return h('div.gstat', h('span.btn.small.ghost.gbtn', {}, 'Разобрать'));
}

function card(g) {
  const opp = opponentOf(g);
  const title = opp ? `vs ${opp.name}` : `${g.white} — ${g.black}`;
  const elo = opp ? [opp.elo && `${opp.elo}`, opp.myElo && `вы ${opp.myElo}`].filter(Boolean).join(' · ') : '';
  const meta = [timeClassName(g.timeClass), formatTimeControl(g.timeControl), formatDate(g.endTime)].filter(Boolean).join(' · ');
  const li = h(`li.gcard.r-${g.result}`, { 'data-id': g.id, tabindex: 0, role: 'button', 'aria-label': `${title}, ${RESULT[g.result] || ''}` },
    h('span.gres', {}, RESULT[g.result] || '—'),
    h('div.gmain', {},
      h('b', {}, title),
      h('small', {}, [elo, g.reason].filter(Boolean).join(' · ')),
      h('small.gmeta', {}, meta)),
    statusNode(g));
  const open = () => {
    if (!isReviewed(g)) enqueueReview(g.id, { front: true });
    navigate('review', g.id);
  };
  li.addEventListener('click', open);
  li.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), open()));
  return li;
}

export async function renderGames() {
  const games = (await db.allGames()).sort((a, b) => (b.endTime || 0) - (a.endTime || 0));
  byId('connect').hidden = !!prefs.username;
  byId('btn-sync').hidden = !prefs.username;
  byId('games-user').textContent = prefs.username ? `chess.com · ${prefs.username}` : 'chess.com';
  const list = byId('game-list');
  list.innerHTML = '';
  for (const g of games) list.append(card(g));
  byId('games-empty').hidden = games.length > 0 || !prefs.username;
}

function refreshCard(id) {
  const li = document.querySelector(`.gcard[data-id="${CSS.escape(id)}"]`);
  if (!li) return;
  db.getGame(id).then((g) => g && li.replaceWith(card(g)));
}

export function initGames() {
  byId('btn-sync').addEventListener('click', syncGames);

  byId('connect').addEventListener('submit', async (e) => {
    e.preventDefault();
    let name;
    try {
      name = normalizeUsername(byId('connect-name').value);
    } catch (err) {
      setStatus(err.message, 'error');
      return;
    }
    if (!name) return;
    byId('connect-name').value = name;
    await setPref('username', name);
    byId('set-name').value = name;
    await renderGames();
    syncGames();
  });

  const dlg = byId('add-game');
  byId('btn-add-game').addEventListener('click', () => {
    byId('add-text').value = '';
    byId('add-error').hidden = true;
    dlg.showModal();
  });
  byId('add-form').addEventListener('submit', async (e) => {
    if (e.submitter && e.submitter.value === 'cancel') return;
    e.preventDefault();
    const btn = byId('add-submit');
    btn.disabled = true;
    try {
      const g = await importShared(byId('add-text').value);
      dlg.close();
      enqueueReview(g.id, { front: true });
      navigate('review', g.id);
    } catch (err) {
      byId('add-error').textContent = err.message;
      byId('add-error').hidden = false;
    } finally {
      btn.disabled = false;
    }
  });

  let raf = 0;
  const update = (d) => {
    if (currentScreen() !== 'games') return;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => refreshCard(d.id));
  };
  on('review-progress', update);
  on('review-queue', update);
  on('reviewed', (d) => {
    update(d);
    if (currentScreen() !== 'review') toast('Партия разобрана — загляни, что сказал тренер.');
  });
  on('review-error', update);
}

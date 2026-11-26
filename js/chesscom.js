// Партии с chess.com: только законченные игры из публичных месячных архивов
// (https://www.chess.com/news/view/published-data-api). Помощи в идущих партиях здесь нет и не будет.
import { Chess } from '../vendor/chess.js';

const API = 'https://api.chess.com/pub/player';

const TIME_CLASS = { bullet: 'Пуля', blitz: 'Блиц', rapid: 'Рапид', daily: 'Заочные', classical: 'Классика' };
const REASON = {
  checkmated: 'мат', resigned: 'сдача', timeout: 'время', abandoned: 'покинул партию',
  agreed: 'соглашение', repetition: 'повторение', stalemate: 'пат', insufficient: 'мало материала',
  '50move': 'правило 50 ходов', timevsinsufficient: 'время, но мало материала', kingofthehill: 'король в центре',
  threecheck: 'три шаха', bughousepartnerlose: 'партнёр проиграл', lose: 'поражение',
};
const DRAWS = new Set(['agreed', 'repetition', 'stalemate', 'insufficient', '50move', 'timevsinsufficient']);

export const timeClassName = (tc) => TIME_CLASS[tc] || tc || '';

/** «180+2» → «3+2», «1/86400» → «1 дн./ход». */
export function formatTimeControl(tc) {
  if (!tc) return '';
  if (tc.includes('/')) {
    const days = Math.round(+tc.split('/')[1] / 86400);
    return `${days} дн./ход`;
  }
  const [base, inc] = tc.split('+');
  const min = +base / 60;
  const m = Number.isInteger(min) ? String(min) : min.toFixed(1).replace(/\.0$/, '');
  return inc ? `${m}+${inc}` : `${m} мин`;
}

/** URL месячных архивов: текущий и предыдущие месяцы. */
export function monthUrls(username, now = new Date(), months = 2) {
  const u = encodeURIComponent(username.trim().toLowerCase());
  const out = [];
  for (let i = 0; i < months; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    out.push(`${API}/${u}/games/${d.getUTCFullYear()}/${mm}`);
  }
  return out;
}

const lower = (s) => String(s || '').toLowerCase();

/** Партия из архива chess.com → наш формат. */
export function normalizeGame(g, username) {
  const u = lower(username);
  const myColor = lower(g.white?.username) === u ? 'w' : lower(g.black?.username) === u ? 'b' : null;
  const wr = g.white?.result;
  const br = g.black?.result;
  let winner = null;
  if (wr === 'win') winner = 'w';
  else if (br === 'win') winner = 'b';
  const result = !winner ? 'draw' : myColor ? (winner === myColor ? 'win' : 'loss') : winner === 'w' ? 'white' : 'black';
  const loserResult = winner === 'w' ? br : winner === 'b' ? wr : wr;
  const kind = /\/daily\//.test(g.url) ? 'daily' : 'live';
  return {
    id: `cc-${kind}-${String(g.url).split('/').pop()}`,
    source: 'chesscom',
    url: g.url,
    pgn: g.pgn,
    white: g.white?.username || '?',
    black: g.black?.username || '?',
    whiteElo: g.white?.rating ?? null,
    blackElo: g.black?.rating ?? null,
    myColor,
    result,
    reason: REASON[loserResult] || (DRAWS.has(wr) ? REASON[wr] : ''),
    timeClass: g.time_class || '',
    timeControl: g.time_control || '',
    endTime: g.end_time || 0,
    rated: !!g.rated,
  };
}

/** Только обычные шахматы с PGN (без 960, bughouse и т.п.). */
export const isStandard = (g) => g && g.rules === 'chess' && typeof g.pgn === 'string' && g.pgn.length > 0;

async function getJson(url, fetchImpl) {
  const r = await fetchImpl(url, { headers: { Accept: 'application/json' } });
  if (r.status === 404) return { notFound: true };
  if (!r.ok) throw new Error(`chess.com ответил ${r.status}`);
  return r.json();
}

/**
 * Последние законченные партии игрока.
 * @returns {Promise<Array>} от новых к старым
 */
export async function fetchRecentGames(username, { months = 2, limit = 30, now = new Date(), fetchImpl = fetch } = {}) {
  const name = username.trim();
  if (!name) throw new Error('Укажи ник chess.com');
  const all = [];
  let found = false;
  for (const url of monthUrls(name, now, months)) {
    const data = await getJson(url, fetchImpl);
    if (data.notFound) continue;
    found = true;
    for (const g of data.games || []) if (isStandard(g)) all.push(normalizeGame(g, name));
  }
  if (!found) {
    const profile = await getJson(`${API}/${encodeURIComponent(name.toLowerCase())}`, fetchImpl);
    if (profile.notFound) throw new Error(`Игрок «${name}» на chess.com не найден`);
  }
  all.sort((a, b) => b.endTime - a.endTime);
  return all.slice(0, limit);
}

/** Разбор присланного текста: ссылка на партию chess.com или PGN. */
export function parseShared(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (/\[\s*(Event|White|Black)\s+"/.test(t) || /^1\.\s*\S/.test(t)) return { type: 'pgn', pgn: t };
  const m = /chess\.com\/[^\s]*?\b(live|daily)\/(?:game\/)?(\d{5,})/i.exec(t);
  if (m) return { type: 'link', kind: m[1].toLowerCase(), gameId: m[2] };
  return null;
}

/** Найти партию по ссылке в архивах игрока (текущий и прошлый месяц). */
export async function findLinkedGame(username, gameId, opts = {}) {
  const games = await fetchRecentGames(username, { ...opts, months: opts.months || 2, limit: 1000 });
  return games.find((g) => g.id.endsWith(`-${gameId}`)) || null;
}

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

/** Партия из PGN, присланного вручную. */
export function gameFromPgn(pgn, username = '') {
  const c = new Chess();
  try {
    c.loadPgn(pgn);
  } catch (e) {
    throw new Error('Не получилось прочитать PGN: проверь, что скопирована вся партия');
  }
  if (!c.history().length) throw new Error('В PGN нет ходов');
  const h = c.getHeaders ? c.getHeaders() : c.header();
  const u = lower(username);
  const myColor = u && lower(h.White) === u ? 'w' : u && lower(h.Black) === u ? 'b' : null;
  const res = h.Result || '*';
  const winner = res === '1-0' ? 'w' : res === '0-1' ? 'b' : null;
  const result = res === '1/2-1/2' ? 'draw' : !winner ? 'unknown' : myColor ? (winner === myColor ? 'win' : 'loss') : winner === 'w' ? 'white' : 'black';
  const date = (h.UTCDate || h.Date || '').replace(/\./g, '-');
  const endTime = /^\d{4}-\d{2}-\d{2}$/.test(date) ? Math.floor(Date.parse(date) / 1000) : Math.floor(Date.now() / 1000);
  return {
    id: `pgn-${hash(c.history().join(' ') + (h.White || '') + (h.Black || '') + date)}`,
    source: 'pgn',
    url: h.Link || '',
    pgn,
    white: h.White || 'Белые',
    black: h.Black || 'Чёрные',
    whiteElo: h.WhiteElo ? +h.WhiteElo || null : null,
    blackElo: h.BlackElo ? +h.BlackElo || null : null,
    myColor,
    result,
    reason: h.Termination || '',
    timeClass: '',
    timeControl: h.TimeControl || '',
    endTime,
    rated: false,
  };
}

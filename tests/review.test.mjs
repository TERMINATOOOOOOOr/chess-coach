import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  monthUrls, normalizeGame, fetchRecentGames, parseShared, gameFromPgn, formatTimeControl, findLinkedGame,
} from '../js/chesscom.js';
import { gamePositions, phaseOf, buildReview, progressStats, winSeries } from '../js/review.js';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/chesscom.json', import.meta.url), 'utf8'));
const NOW = new Date(Date.UTC(2026, 10, 26));

function fakeFetch(map) {
  return async (url) => {
    const key = Object.keys(map).find((k) => url.endsWith(k));
    if (!key) return { status: 404, ok: false, json: async () => ({}) };
    return { status: 200, ok: true, json: async () => map[key] };
  };
}
const archiveFetch = fakeFetch({ 'testplayer/games/2026/11': fixture['2026/11'], 'testplayer/games/2026/10': fixture['2026/10'] });

test('адреса месячных архивов, переход через год', () => {
  assert.deepEqual(monthUrls('TestPlayer', NOW, 2), [
    'https://api.chess.com/pub/player/testplayer/games/2026/11',
    'https://api.chess.com/pub/player/testplayer/games/2026/10',
  ]);
  const jan = monthUrls('x', new Date(Date.UTC(2027, 0, 5)), 2);
  assert.ok(jan[1].endsWith('/2026/12'));
});

test('нормализация партии: мой цвет без учёта регистра, результат, причина', () => {
  const g = normalizeGame(fixture['2026/11'].games[0], 'testplayer');
  assert.equal(g.myColor, 'b');
  assert.equal(g.result, 'loss');
  assert.equal(g.reason, 'мат');
  assert.equal(g.id, 'cc-live-100000001');
  const d = normalizeGame(fixture['2026/10'].games[0], 'TESTPLAYER');
  assert.equal(d.result, 'draw');
  assert.equal(d.reason, 'соглашение');
  assert.equal(d.id, 'cc-daily-200000004');
});

test('загрузка партий: два месяца, без шахмат-960, новые сначала', async () => {
  const games = await fetchRecentGames('TestPlayer', { now: NOW, fetchImpl: archiveFetch });
  assert.deepEqual(games.map((g) => g.id), ['cc-live-100000002', 'cc-live-100000001', 'cc-daily-200000004']);
  assert.equal(games[0].result, 'win');
});

test('несуществующий игрок даёт понятную ошибку', async () => {
  await assert.rejects(() => fetchRecentGames('nobody', { now: NOW, fetchImpl: fakeFetch({}) }), /не найден/);
});

test('разбор присланного текста: ссылки chess.com и PGN', () => {
  assert.deepEqual(parseShared('Смотри мою партию https://www.chess.com/game/live/100000002'), { type: 'link', kind: 'live', gameId: '100000002' });
  assert.deepEqual(parseShared('https://www.chess.com/live/game/123456789'), { type: 'link', kind: 'live', gameId: '123456789' });
  assert.deepEqual(parseShared('https://www.chess.com/analysis/game/daily/55555555?tab=review'), { type: 'link', kind: 'daily', gameId: '55555555' });
  assert.equal(parseShared(fixture['2026/11'].games[0].pgn).type, 'pgn');
  assert.equal(parseShared('1. e4 e5 2. Nf3').type, 'pgn');
  assert.equal(parseShared('привет'), null);
});

test('ссылка находится в архиве игрока', async () => {
  const g = await findLinkedGame('testplayer', '100000002', { now: NOW, fetchImpl: archiveFetch });
  assert.equal(g.id, 'cc-live-100000002');
  assert.equal(await findLinkedGame('testplayer', '999999999', { now: NOW, fetchImpl: archiveFetch }), null);
});

test('партия из PGN: заголовки, мой цвет, ошибка на мусоре', () => {
  const g = gameFromPgn(fixture['2026/11'].games[1].pgn, 'testplayer');
  assert.equal(g.myColor, 'w');
  assert.equal(g.result, 'win');
  assert.equal(g.white, 'TestPlayer');
  assert.ok(g.id.startsWith('pgn-'));
  assert.throws(() => gameFromPgn('это не pgn 1. xx'), /PGN/);
});

test('контроль времени по-русски', () => {
  assert.equal(formatTimeControl('180+2'), '3+2');
  assert.equal(formatTimeControl('600'), '10 мин');
  assert.equal(formatTimeControl('1/86400'), '1 дн./ход');
});

test('позиции партии и фаза', () => {
  const { plies, startFen } = gamePositions(fixture['2026/11'].games[0].pgn);
  assert.equal(plies.length, 7);
  assert.equal(plies[0].uci, 'e2e4');
  assert.equal(startFen.split(' ')[0], 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR');
  assert.equal(phaseOf(startFen), 'opening');
  assert.equal(phaseOf('4k3/8/8/8/8/8/4P3/R3K3 w - - 0 40'), 'endgame');
  assert.equal(phaseOf('r1bqkb1r/pppp1ppp/2n2n2/4p3/4P3/2N2N2/PPPP1PPP/R1BQKB1R w KQkq - 0 20'), 'middlegame');
});

test('сборка разбора и статистика прогресса на синтетических анализах', () => {
  const { startFen, plies } = gamePositions(fixture['2026/11'].games[0].pgn);
  // каждой позиции — простая «линия движка»: играть то, что сыграно, оценка 0; перед Кf6 — лучше d6, после Кf6 — мат
  const analyses = [];
  for (let i = 0; i <= plies.length; i++) {
    if (i === plies.length) {
      analyses.push(null);
      continue;
    }
    const p = plies[i];
    if (p.san === 'Nf6') {
      analyses.push({ lines: [{ move: 'g7g6', pv: ['g7g6'], cp: -20, mate: null, multipv: 1 }] });
    } else if (i > 0 && plies[i - 1].san === 'Nf6') {
      analyses.push({ lines: [{ move: 'h5f7', pv: ['h5f7'], cp: null, mate: 1, multipv: 1 }] });
    } else {
      analyses.push({ lines: [{ move: p.uci, pv: [p.uci], cp: 0, mate: null, multipv: 1 }] });
    }
  }
  const review = buildReview({ startFen, plies, analyses });
  const nf6 = review.plies[5];
  assert.equal(nf6.cls, 'blunder');
  assert.equal(nf6.type, 'allowed_mate');
  assert.equal(nf6.best.ru, 'g6');
  assert.ok(review.keyMoments.includes(5));
  assert.equal(review.plies[6].cls, 'best');
  assert.equal(winSeries(review).length, plies.length + 1);
  const stats = progressStats([{ id: 'a', endTime: 1, myColor: 'b', result: 'loss', review }]);
  assert.equal(stats.games, 1);
  assert.equal(stats.types.allowed_mate, 1);
  assert.equal(stats.phases.opening.errors, 1);
});

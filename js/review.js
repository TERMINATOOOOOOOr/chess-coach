// Разбор законченной партии: один анализ движка на позицию.
// Анализ позиции i — это «до» для хода i и «после» для хода i-1, поэтому позиций N+1, а не 2N.
import { Chess } from '../vendor/chess.js';
import {
  CLASSES, VALUE, evaluateMove, explainMove, toWhite, ruSan, uciToMove, moveFeatures, pvMaterial, winPct,
  classifyByDrop, moveAccuracy,
} from './coach.js';

export const REVIEW_VERSION = 1;
export const REVIEW_MODES = {
  fast: { depth: 10, movetime: 900 },
  accurate: { depth: 12, movetime: 2000 },
};

// На малой глубине Stockfish 10 сильнее всего «шумит» в дебюте: обычные теоретические ходы получают
// падение оценки в 5–10 %. В первых ходах смягчаем падение, настоящие зевки (десятки %) остаются зевками.
const OPENING_FULLMOVES = 8;
const OPENING_DAMPING = 0.6;

export const ERROR_TYPES = {
  allowed_mate: 'Допустил мат',
  missed_mate: 'Упустил мат',
  hung_piece: 'Зевнул материал',
  missed_tactic: 'Упустил тактику',
  positional: 'Позиционная ошибка',
};

export const PHASES = { opening: 'Дебют', middlegame: 'Миттельшпиль', endgame: 'Эндшпиль' };

/** Позиции партии из PGN. */
export function gamePositions(pgn) {
  const c = new Chess();
  c.loadPgn(pgn);
  const hist = c.history({ verbose: true });
  const headers = c.getHeaders();
  const startFen = hist.length ? hist[0].before : c.fen();
  const plies = hist.map((m) => ({
    san: m.san,
    uci: m.from + m.to + (m.promotion || ''),
    color: m.color,
    fenBefore: m.before,
    fenAfter: m.after,
  }));
  return { startFen, plies, headers };
}

function nonPawnMaterial(fen) {
  let s = 0;
  for (const ch of fen.split(' ')[0]) {
    const t = ch.toLowerCase();
    if ('nbrq'.includes(t)) s += VALUE[t];
  }
  return s;
}

/** Фаза партии в позиции перед ходом. */
export function phaseOf(fen) {
  const moveNo = +fen.split(' ')[5] || 1;
  const mat = nonPawnMaterial(fen);
  if (mat <= 20) return 'endgame';
  if (moveNo <= 12) return 'opening';
  return 'middlegame';
}

/** Тип ошибки — для статистики «что у меня болит». */
export function errorType({ fenBefore, uci, result, after }) {
  const best = result.bestLine;
  const reply = after && after.lines[0];
  if (reply && reply.mate != null && reply.mate > 0) return 'allowed_mate';
  if (best.mate != null && best.mate > 0) return 'missed_mate';
  const f = moveFeatures(fenBefore, uci);
  if (reply) {
    const g = pvMaterial(f.fenAfter, reply.pv);
    if (g.net >= 2 || f.movedHanging) return 'hung_piece';
  }
  const bf = moveFeatures(fenBefore, best.move);
  if (bf.winningCapture || bf.fork || pvMaterial(fenBefore, best.pv).net >= 2) return 'missed_tactic';
  return 'positional';
}

/** Оценка (с точки зрения белых) позиции, где партия закончилась. */
function terminalScore(fen) {
  const c = new Chess(fen);
  if (c.isCheckmate()) return { cp: null, mate: c.turn() === 'w' ? -1 : 1 };
  return { cp: 0, mate: null };
}

/**
 * Анализирует партию.
 * @param game    {pgn, myColor}
 * @param engine  Engine (engine.js)
 * @param opts    {mode, onProgress(0..1), waitIfBusy(): Promise, isCancelled(): bool}
 * @returns разбор или null, если отменён
 */
export async function analyzeGame(game, engine, { mode = 'accurate', onProgress, waitIfBusy, isCancelled } = {}) {
  const { startFen, plies } = gamePositions(game.pgn);
  const cfg = REVIEW_MODES[mode] || REVIEW_MODES.accurate;
  const analyses = [];
  for (let i = 0; i <= plies.length; i++) {
    if (waitIfBusy) await waitIfBusy();
    if (isCancelled && isCancelled()) return null;
    const fen = i === 0 ? startFen : plies[i - 1].fenAfter;
    if (new Chess(fen).isGameOver()) {
      analyses.push(null);
    } else {
      const moves = plies.slice(0, i).map((p) => p.uci);
      const a = await engine.analyse(startFen, { ...cfg, multipv: 2, moves });
      if (a.cancelled) return null;
      // сыгранного хода нет среди лучших линий — считаем его из той же позиции на ту же глубину,
      // иначе сравниваются оценки разных поисков и мелкие колебания движка выглядят как ошибки
      const played = plies[i];
      if (played && a.lines.length && !a.lines.some((l) => l.move === played.uci)) {
        const s = await engine.analyse(startFen, { depth: a.lines[0].depth || cfg.depth, multipv: 1, moves, searchmoves: [played.uci] });
        if (s.cancelled) return null;
        const own = s.lines.find((l) => l.move === played.uci);
        if (own) a.lines.push({ ...own, multipv: 99 });
      }
      analyses.push(a);
    }
    if (onProgress) onProgress((i + 1) / (plies.length + 1));
  }
  return buildReview({ startFen, plies, analyses, mode });
}

/** Собирает разбор из уже посчитанных анализов (отдельно — чтобы тестировать без движка). */
export function buildReview({ startFen, plies, analyses, mode = 'accurate' }) {
  const evalOf = (i) => {
    const fen = i === 0 ? startFen : plies[i - 1].fenAfter;
    const a = analyses[i];
    if (!a || !a.lines.length) return terminalScore(fen);
    return toWhite(a.lines[0], fen.split(' ')[1]);
  };
  const evals = analyses.map((_, i) => evalOf(i));
  const out = [];
  for (let i = 0; i < plies.length; i++) {
    const p = plies[i];
    const before = analyses[i];
    const after = analyses[i + 1];
    const result = before ? evaluateMove({ fenBefore: p.fenBefore, uci: p.uci, before, after }) : null;
    if (result && (+p.fenBefore.split(' ')[5] || 1) <= OPENING_FULLMOVES && !['best', 'sac', 'forced', 'blunder'].includes(result.cls)) {
      result.drop *= OPENING_DAMPING;
      const c = classifyByDrop(result.drop);
      result.cls = c === 'best' ? 'excellent' : c;
      result.accuracy = moveAccuracy(result.drop);
    }
    const row = {
      san: p.san,
      ru: ruSan(p.san),
      uci: p.uci,
      color: p.color,
      fenBefore: p.fenBefore,
      fenAfter: p.fenAfter,
      evalAfter: evals[i + 1],
      phase: phaseOf(p.fenBefore),
      cls: null,
      accuracy: null,
      comment: '',
      best: null,
      type: null,
    };
    if (result) {
      row.cls = result.cls;
      row.accuracy = result.accuracy;
      row.drop = result.drop;
      row.comment = explainMove({ fenBefore: p.fenBefore, uci: p.uci, result, after });
      const bm = result.bestLine.move;
      if (bm !== p.uci) {
        const san = new Chess(p.fenBefore).move(uciToMove(bm)).san;
        row.best = { uci: bm, ru: ruSan(san) };
      }
      if (['inaccuracy', 'mistake', 'blunder'].includes(result.cls)) {
        row.type = errorType({ fenBefore: p.fenBefore, uci: p.uci, result, after });
      }
    }
    out.push(row);
  }
  const side = (color) => {
    const rows = out.filter((r) => r.color === color && r.cls);
    const counts = Object.fromEntries(Object.keys(CLASSES).map((k) => [k, 0]));
    for (const r of rows) counts[r.cls]++;
    const acc = rows.length ? rows.reduce((s, r) => s + r.accuracy, 0) / rows.length : null;
    return { accuracy: acc, counts, moves: rows.length };
  };
  const keyMoments = out
    .map((r, i) => ({ i, r }))
    .filter(({ r }) => r.cls === 'mistake' || r.cls === 'blunder' || r.cls === 'sac')
    .map(({ i }) => i);
  return {
    version: REVIEW_VERSION,
    mode,
    startFen,
    evalStart: evals[0],
    plies: out,
    sides: { w: side('w'), b: side('b') },
    keyMoments,
  };
}

/** Шанс белых на победу по ходам — для графика. */
export function winSeries(review) {
  return [review.evalStart, ...review.plies.map((p) => p.evalAfter)].map((s) => winPct(s, 'w'));
}

/** Статистика по нескольким разобранным партиям (только мои ходы). */
export function progressStats(games) {
  const done = games
    .filter((g) => g.review && g.myColor)
    .sort((a, b) => a.endTime - b.endTime);
  const perGame = done.map((g) => {
    const s = g.review.sides[g.myColor];
    return {
      id: g.id,
      endTime: g.endTime,
      accuracy: s.accuracy,
      blunders: s.counts.blunder,
      mistakes: s.counts.mistake,
      inaccuracies: s.counts.inaccuracy,
      result: g.result,
    };
  });
  const phases = Object.fromEntries(Object.keys(PHASES).map((k) => [k, { moves: 0, accSum: 0, errors: 0 }]));
  const types = Object.fromEntries(Object.keys(ERROR_TYPES).map((k) => [k, 0]));
  for (const g of done) {
    for (const r of g.review.plies) {
      if (r.color !== g.myColor || !r.cls) continue;
      const ph = phases[r.phase];
      ph.moves++;
      ph.accSum += r.accuracy;
      if (r.cls === 'mistake' || r.cls === 'blunder') {
        ph.errors++;
        if (r.type) types[r.type]++;
      }
    }
  }
  const n = perGame.length;
  const avg = (f) => (n ? perGame.reduce((s, x) => s + f(x), 0) / n : null);
  return {
    games: n,
    accuracy: avg((x) => x.accuracy ?? 0),
    blundersPerGame: avg((x) => x.blunders),
    mistakesPerGame: avg((x) => x.mistakes),
    perGame,
    phases: Object.fromEntries(
      Object.entries(phases).map(([k, v]) => [k, { moves: v.moves, errors: v.errors, accuracy: v.moves ? v.accSum / v.moves : null }]),
    ),
    types,
  };
}

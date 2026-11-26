// Тренер: оценка ходов, поиск угроз и объяснения по-русски.
// Чистые функции поверх chess.js и данных Stockfish — без DOM, тестируются в Node.
import { Chess } from '../vendor/chess.js';

export const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

const NAMES = {
  p: { nom: 'пешка', acc: 'пешку', ins: 'пешкой' },
  n: { nom: 'конь', acc: 'коня', ins: 'конём' },
  b: { nom: 'слон', acc: 'слона', ins: 'слоном' },
  r: { nom: 'ладья', acc: 'ладью', ins: 'ладьёй' },
  q: { nom: 'ферзь', acc: 'ферзя', ins: 'ферзём' },
  k: { nom: 'король', acc: 'короля', ins: 'королём' },
};
export const pieceName = (type, form = 'nom') => NAMES[type][form];
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

const RU_LETTERS = { K: 'Кр', Q: 'Ф', R: 'Л', B: 'С', N: 'К' };
/** SAN в русской нотации: Nf3 → Кf3, e8=Q → e8=Ф. */
export const ruSan = (san) => san.replace(/[KQRBN]/g, (m) => RU_LETTERS[m]);

export function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}
const mateIn = (n) => `мат в ${n} ${plural(n, 'ход', 'хода', 'ходов')}`;

export const CLASSES = {
  sac: { label: 'Сильная жертва', sym: '!!' },
  best: { label: 'Лучший ход', sym: '✦' },
  excellent: { label: 'Отличный ход', sym: '!' },
  good: { label: 'Хороший ход', sym: '✓' },
  forced: { label: 'Единственный ход', sym: '□' },
  inaccuracy: { label: 'Неточность', sym: '?!' },
  mistake: { label: 'Ошибка', sym: '?' },
  blunder: { label: 'Зевок', sym: '??' },
};

// ───────────────────────── оценки ─────────────────────────

export const opposite = (color) => (color === 'w' ? 'b' : 'w');

export function uciToMove(uci) {
  return { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || undefined };
}

/** Оценка строки движка (с точки зрения стороны, чей ход) → с точки зрения белых. */
export function toWhite(line, stm) {
  const s = stm === 'w' ? 1 : -1;
  if (line.mate === 0) return { cp: null, mate: -s }; // сторона, чей ход, уже получила мат
  return {
    cp: line.cp == null ? null : line.cp * s,
    mate: line.mate == null ? null : line.mate * s,
  };
}

/** Шанс на победу (0–100) для цвета color по оценке с точки зрения белых. */
export function winPct(score, color) {
  let white;
  if (score.mate != null) white = score.mate > 0 ? 100 : 0;
  else white = 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * score.cp)) - 1);
  return color === 'w' ? white : 100 - white;
}

export function formatEval(score) {
  if (!score) return '…';
  if (score.mate != null) return `${score.mate > 0 ? '+' : '−'}M${Math.abs(score.mate)}`;
  const v = score.cp / 100;
  if (Math.abs(v) < 0.05) return '0.0';
  return `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}`;
}

export function classifyByDrop(drop) {
  if (drop <= 0.5) return 'best';
  if (drop < 2) return 'excellent';
  if (drop < 5) return 'good';
  if (drop < 10) return 'inaccuracy';
  if (drop < 20) return 'mistake';
  return 'blunder';
}

/** Точность хода по падению шанса на победу (формула в духе lichess). */
export function moveAccuracy(drop) {
  const a = 103.1668 * Math.exp(-0.04354 * drop) - 3.1669;
  return Math.max(0, Math.min(100, a));
}

// ───────────────────────── позиция ─────────────────────────

function pieces(c, color) {
  const out = [];
  for (const row of c.board()) for (const p of row) if (p && (!color || p.color === color)) out.push(p);
  return out;
}

export function material(c, color) {
  return pieces(c, color).reduce((s, p) => s + VALUE[p.type], 0);
}

const attackerValue = (c, sq) => {
  const t = c.get(sq).type;
  return t === 'k' ? 100 : VALUE[t];
};

/** Фигура висит: её бьют, а защиты нет или бьёт более дешёвая фигура. */
export function isHanging(c, sq) {
  const p = c.get(sq);
  if (!p || p.type === 'k') return false;
  const att = c.attackers(sq, opposite(p.color));
  if (!att.length) return false;
  const def = c.attackers(sq, p.color);
  if (!def.length) return true;
  return Math.min(...att.map((s) => attackerValue(c, s))) < VALUE[p.type];
}

export function hangingPieces(c, color, minValue = 3) {
  return pieces(c, color)
    .filter((p) => p.type !== 'k' && VALUE[p.type] >= minValue && isHanging(c, p.square))
    .sort((a, b) => VALUE[b.type] - VALUE[a.type]);
}

/** Ходы, которые сразу ставят мат (для стороны, чей ход). */
export function mateInOneMoves(c) {
  const out = [];
  for (const m of c.moves({ verbose: true })) {
    c.move(m);
    if (c.isCheckmate()) out.push(m);
    c.undo();
  }
  return out;
}

/** FEN с передачей хода — «что соперник сделал бы, если бы ход был его». */
export function nullMoveFen(fen) {
  const parts = fen.split(' ');
  parts[1] = parts[1] === 'w' ? 'b' : 'w';
  parts[3] = '-';
  return parts.join(' ');
}

export function pvToRu(fen, pv, n = 4) {
  const c = new Chess(fen);
  const out = [];
  for (const uci of pv.slice(0, n)) {
    try {
      out.push(ruSan(c.move(uciToMove(uci)).san));
    } catch {
      break;
    }
  }
  return out;
}

/**
 * Проигрывает линию движка и считает, сколько материала выигрывает сторона, чей ход.
 * Останавливается в «спокойной» точке, чтобы не обрывать размен на середине.
 */
export function pvMaterial(fen, pv, maxPlies = 8) {
  const c = new Chess(fen);
  const me = c.turn();
  const diff = () => material(c, me) - material(c, opposite(me));
  const start = diff();
  const gained = [];
  const lost = [];
  let promoted = false;
  let n = 0;
  for (const uci of pv) {
    let mv;
    try {
      mv = c.move(uciToMove(uci));
    } catch {
      break;
    }
    n++;
    if (mv.captured) (mv.color === me ? gained : lost).push(mv.captured);
    if (mv.promotion && mv.color === me) promoted = true;
    const quiet = !mv.captured && !mv.promotion;
    if (n >= maxPlies && (quiet || n >= maxPlies + 4)) break;
  }
  // взаимно гасим одинаковые взятия
  for (let i = gained.length - 1; i >= 0; i--) {
    const j = lost.indexOf(gained[i]);
    if (j !== -1) {
      lost.splice(j, 1);
      gained.splice(i, 1);
    }
  }
  return { net: diff() - start, gained, lost, promoted };
}

/** Что именно выигрывается: «коня», «качество», «ферзя»… */
export function gainWord({ net, gained, lost, promoted }) {
  if (net <= 0) return null;
  const byValue = [...gained].sort((a, b) => VALUE[b] - VALUE[a]);
  if (byValue[0] === 'q') return 'ферзя';
  if (promoted && net >= 5 && !byValue.length) return 'ферзя (через превращение)';
  if (byValue[0] === 'r' && net <= 2 && lost.some((t) => t === 'n' || t === 'b')) return 'качество';
  if (byValue.length) {
    if (net === 2 && byValue[0] === 'p') return 'две пешки';
    return pieceName(byValue[0], 'acc');
  }
  if (net >= 3) return 'материал';
  return net === 1 ? 'пешку' : 'две пешки';
}

// ───────────────────────── признаки хода ─────────────────────────

const CENTER = new Set(['d4', 'e4', 'd5', 'e5']);

/** Разбирает ход: что берёт, кому угрожает, что защищает. */
export function moveFeatures(fen, uci) {
  const c = new Chess(fen);
  const me = c.turn();
  const opp = opposite(me);
  const before = new Chess(fen);
  const myHangingBefore = hangingPieces(before, me, 3);
  const capturedWasHanging = (() => {
    const t = before.get(uci.slice(2, 4));
    return !!t && t.color === opp && isHanging(before, uci.slice(2, 4));
  })();
  const moveNo = c.moveNumber();
  // угрожал ли соперник матом в один ход до нашего хода
  let mateThreat = null;
  if (!before.inCheck()) {
    try {
      mateThreat = mateInOneMoves(new Chess(nullMoveFen(fen)))[0] || null;
    } catch {
      mateThreat = null;
    }
  }
  const mv = c.move(uciToMove(uci));
  const moved = mv.promotion || mv.piece;

  const f = {
    san: mv.san,
    ru: ruSan(mv.san),
    piece: mv.piece,
    from: mv.from,
    to: mv.to,
    captured: mv.captured || null,
    promotion: mv.promotion || null,
    castle: mv.flags.includes('k') || mv.flags.includes('q'),
    check: c.inCheck(),
    mate: c.isCheckmate(),
    fenAfter: c.fen(),
  };

  f.winningCapture =
    !!mv.captured && (VALUE[mv.captured] > VALUE[mv.piece] || capturedWasHanging || mv.piece === 'k');
  f.trade = !!mv.captured && !f.winningCapture && VALUE[mv.captured] === VALUE[mv.piece];
  f.movedHanging = isHanging(c, mv.to);

  // вилка / нападение: цели, которые бьёт сходившая фигура
  const targets = [];
  for (const p of pieces(c, opp)) {
    if (!c.attackers(p.square, me).includes(mv.to)) continue;
    if (p.type === 'k') targets.push(p);
    else if (VALUE[p.type] > VALUE[moved] || (VALUE[p.type] >= 3 && !c.attackers(p.square, opp).length)) targets.push(p);
  }
  targets.sort((a, b) => (b.type === 'k' ? 100 : VALUE[b.type]) - (a.type === 'k' ? 100 : VALUE[a.type]));
  f.fork = targets.length >= 2 && !f.movedHanging ? targets.map((t) => t.type) : null;
  f.attacks = !f.fork && targets.length === 1 && targets[0].type !== 'k' && !f.movedHanging ? targets[0].type : null;

  // спасение своей висящей фигуры
  const stillHanging = new Set(hangingPieces(c, me, 3).map((p) => p.square));
  const fromWasHanging = myHangingBefore.find((p) => p.square === mv.from);
  if (fromWasHanging && !f.movedHanging) f.escapes = fromWasHanging.type;
  const defended = myHangingBefore.find((p) => p.square !== mv.from && !stillHanging.has(p.square));
  if (defended) f.defends = { type: defended.type, square: defended.square };

  f.stopsMate = mateThreat && !f.mate && !mateInOneMoves(c).length ? ruSan(mateThreat.san) : null;

  const homeRank = me === 'w' ? '1' : '8';
  f.develops = (mv.piece === 'n' || mv.piece === 'b') && mv.from[1] === homeRank && moveNo <= 15;
  f.center = mv.piece === 'p' && CENTER.has(mv.to) && moveNo <= 12;
  return f;
}

/** Причины, почему ход хорош (для подсказок и разбора). */
export function moveReasons(fen, line) {
  const f = moveFeatures(fen, line.move);
  const r = [];
  if (f.mate) r.push('ставит мат');
  else if (line.mate != null && line.mate > 0) r.push(`ведёт к форсированному мату (${mateIn(line.mate)})`);
  if (f.stopsMate) r.push(`защищает от мата ${f.stopsMate}`);

  if (f.captured && f.winningCapture) r.push(`выигрывает ${pieceName(f.captured, 'acc')}`);
  else if (f.captured && f.trade) r.push('размен');
  else if (f.captured) r.push(`берёт ${pieceName(f.captured, 'acc')}`);

  if (f.fork) {
    const [a, b] = f.fork;
    if (a === 'k') r.push(`шах с нападением на ${pieceName(b, 'acc')}`);
    else r.push(`вилка: нападает на ${pieceName(a, 'acc')} и ${pieceName(b, 'acc')}`);
  } else if (f.check && !f.mate) r.push('шах');

  if (f.promotion) r.push(`превращение в ${pieceName(f.promotion, 'acc')}`);
  if (f.escapes) r.push(`уводит ${pieceName(f.escapes, 'acc')} из-под удара`);
  if (f.defends) r.push(`защищает ${pieceName(f.defends.type, 'acc')} на ${f.defends.square}`);
  if (f.castle) r.push('рокировка: король уходит в безопасность');
  if (f.attacks) r.push(`нападает на ${pieceName(f.attacks, 'acc')}`);

  if (!f.captured && !f.mate && !(line.mate > 0)) {
    const g = pvMaterial(fen, line.pv);
    const w = gainWord(g);
    if (w && g.net >= 2) r.push(`по линии движка выигрывается ${w}`);
  }
  if (f.develops) r.push('развивает фигуру');
  if (f.center) r.push('занимает центр');
  const quiet = !r.length;
  if (quiet) r.push('позиционный ход, улучшает позицию');
  return { features: f, reasons: r.slice(0, 2), quiet };
}

/** Короткая причина для списка топ-ходов. */
export function shortReason(fen, line) {
  return moveReasons(fen, line).reasons[0];
}

// ───────────────────────── оценка хода игрока ─────────────────────────

/** Жертва: отданная фигура стоит под боем, а за неё почти ничего не взято. */
export function isSacrifice(fen, uci) {
  const c = new Chess(fen);
  const mv = c.move(uciToMove(uci));
  const v = VALUE[mv.promotion || mv.piece];
  if (v < 3) return false;
  const gained = mv.captured ? VALUE[mv.captured] : 0;
  if (v - gained < 2 || !isHanging(c, mv.to)) return false;
  // соперник должен реально мочь забрать фигуру (не мешает связка)
  return c.moves({ verbose: true }).some((m) => m.to === mv.to);
}

/**
 * Оценивает ход игрока.
 * @param before анализ позиции ДО хода (MultiPV, оценки со стороны игрока)
 * @param after  анализ позиции ПОСЛЕ хода (ход соперника), может быть null если партия окончена
 */
export function evaluateMove({ fenBefore, uci, before, after }) {
  if (!before || !before.lines.length) return null;
  const c = new Chess(fenBefore);
  const color = c.turn();
  const legalCount = c.moves().length;
  c.move(uciToMove(uci));
  const best = before.lines[0];
  const bestScore = toWhite(best, color);
  const inTop = before.lines.find((l) => l.move === uci);

  let afterScore;
  if (c.isCheckmate()) afterScore = { cp: null, mate: color === 'w' ? 1 : -1 };
  else if (c.isDraw()) afterScore = { cp: 0, mate: null };
  else if (inTop) afterScore = toWhite(inTop, color);
  else if (after && after.lines.length) afterScore = toWhite(after.lines[0], c.turn());
  else return null;

  const winBefore = winPct(bestScore, color);
  const winAfter = winPct(afterScore, color);
  const drop = Math.max(0, winBefore - winAfter);

  let cls;
  if (legalCount === 1) cls = 'forced';
  else if (uci === best.move || c.isCheckmate()) cls = 'best';
  else cls = classifyByDrop(drop);
  if ((cls === 'best' || (cls === 'excellent' && drop < 1)) && winAfter >= 45 && isSacrifice(fenBefore, uci)) cls = 'sac';

  return {
    cls,
    drop,
    accuracy: cls === 'forced' ? 100 : moveAccuracy(drop),
    bestScore,
    afterScore,
    bestLine: best,
    line: inTop || null,
    color,
  };
}

/** Текст тренера после хода игрока. */
export function explainMove({ fenBefore, uci, result, after }) {
  const f = moveFeatures(fenBefore, uci);
  const { cls, bestLine } = result;
  const bestRu = ruSan(new Chess(fenBefore).move(uciToMove(bestLine.move)).san);
  const bestWhy = moveReasons(fenBefore, bestLine).reasons.join(', ');
  const label = CLASSES[cls].label;

  if (f.mate) return `${f.ru} — мат! Отличная работа.`;
  if (cls === 'forced') return `${f.ru} — единственный ход в этой позиции.`;
  if (cls === 'sac') {
    return `${f.ru}!! Сильная жертва: ${pieceName(f.promotion || f.piece, 'nom')} отдаётся, но позиция от этого только лучше.`;
  }
  if (cls === 'best') {
    const own = result.line || { move: uci, pv: [uci], cp: 0, mate: null };
    const why = moveReasons(fenBefore, own).reasons.join(', ');
    return `${f.ru} — лучший ход: ${why}.`;
  }
  if (cls === 'excellent') return `${f.ru} — отличный ход, почти как у движка. Самый точный — ${bestRu}.`;
  if (cls === 'good') return `${f.ru} — хороший ход. Чуть сильнее было ${bestRu}: ${bestWhy}.`;

  // неточность / ошибка / зевок: объясняем последствия
  const parts = [`${f.ru} — ${label.toLowerCase()}.`];
  const reply = after && after.lines[0];
  const fenAfter = f.fenAfter;
  let consequence = '';
  if (reply && reply.mate != null && reply.mate > 0) {
    const r = pvToRu(fenAfter, reply.pv, 1)[0];
    consequence = `Теперь у соперника ${mateIn(reply.mate)}, начиная с ${r}.`;
  } else if (reply) {
    const g = pvMaterial(fenAfter, reply.pv);
    const w = gainWord(g);
    const r = pvToRu(fenAfter, reply.pv, 1)[0];
    if (w && g.net >= 1 && r) consequence = `Соперник отвечает ${r} и выигрывает ${w}.`;
  }
  if (!consequence && bestLine.mate != null && bestLine.mate > 0) consequence = `Упущен ${mateIn(bestLine.mate)}.`;
  if (!consequence && f.movedHanging) {
    consequence = `${cap(pieceName(f.promotion || f.piece, 'nom'))} на ${f.to} остаётся без защиты.`;
  }
  if (!consequence) {
    consequence = `Оценка: ${formatEval(result.bestScore)} → ${formatEval(result.afterScore)}.`;
  }
  parts.push(consequence);
  parts.push(`Лучше было ${bestRu}: ${bestWhy}.`);
  return parts.join(' ');
}

// ───────────────────────── угрозы и подсказки ─────────────────────────

/**
 * Угроза соперника. fen — позиция, где ходит игрок.
 * threat — анализ nullMoveFen(fen) (ход соперника), current — анализ самой позиции.
 */
export function describeThreat(fen, threat) {
  const c = new Chess(fen);
  if (c.inCheck()) return null;
  const me = c.turn();
  const hanging = hangingPieces(c, me, 3);
  const line = threat && threat.lines[0];
  if (line) {
    const nf = nullMoveFen(fen);
    const r = pvToRu(nf, line.pv, 1)[0];
    if (line.mate != null && line.mate > 0 && line.mate <= 3) {
      return { severity: 'high', move: line.move, text: `Угроза мата! Соперник хочет сыграть ${r}${line.mate > 1 ? ` (${mateIn(line.mate)})` : ''}.` };
    }
    const g = pvMaterial(nf, line.pv, 6);
    const w = gainWord(g);
    if (w && g.net >= 2) {
      return { severity: g.net >= 3 ? 'high' : 'mid', move: line.move, text: `Внимание: соперник угрожает ${r} и выигрывает ${w}.` };
    }
  }
  if (hanging.length) {
    const p = hanging[0];
    return { severity: 'mid', move: null, square: p.square, text: `${cap(pieceName(p.type))} на ${p.square} под ударом.` };
  }
  return null;
}

/** Подсказка по уровням: 1 — идея, 2 — какая фигура, 3 — ход целиком. */
export function hint(fen, analysis, tier) {
  const line = analysis.lines[0];
  const { features: f, reasons, quiet } = moveReasons(fen, line);
  if (tier >= 3) {
    const tail = quiet ? ' Острой тактики нет, но движок считает этот ход сильнейшим.' : '';
    return { text: `${f.ru} — ${reasons.join(', ')}.${tail}`, from: f.from, to: f.to };
  }
  if (tier === 2) {
    return { text: `Сходи ${pieceName(f.piece, 'ins')} с ${f.from}.`, from: f.from };
  }
  let text;
  if (f.mate || (line.mate != null && line.mate > 0)) text = 'Здесь есть форсированный мат. Посмотри на шахи!';
  else if (f.stopsMate) text = 'Соперник угрожает матом в один ход. Сначала защитись!';
  else if (f.fork) text = 'Есть двойной удар: ищи ход, который нападает сразу на две цели.';
  else if (f.winningCapture) text = 'Можно выиграть материал: что-то у соперника плохо защищено.';
  else if (f.escapes || f.defends) text = 'Одна из твоих фигур под ударом. Сначала позаботься о ней.';
  else if (pvMaterial(fen, line.pv).net >= 2) text = 'Есть тактика: можно выиграть материал за пару ходов.';
  else if (f.check) text = 'Присмотрись к шахам.';
  else if (f.castle) text = 'Подумай о безопасности короля.';
  else if (f.develops) text = 'Не все фигуры в игре: развивай их.';
  else if (f.center) text = 'Борись за центр доски.';
  else if (f.attacks) text = 'Можно напасть на фигуру соперника.';
  else text = 'Острой тактики нет. Улучши самую пассивную фигуру.';
  return { text };
}

// ───────────────────────── итог партии ─────────────────────────

export function summarize(entries) {
  const counts = Object.fromEntries(Object.keys(CLASSES).map((k) => [k, 0]));
  const accs = [];
  for (const e of entries) {
    if (!e.result) continue;
    counts[e.result.cls]++;
    accs.push(e.result.accuracy);
  }
  const accuracy = accs.length ? accs.reduce((a, b) => a + b, 0) / accs.length : null;
  return { counts, accuracy, moves: accs.length };
}

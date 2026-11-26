// Боты-соперники. Stockfish даже на Skill 0 играет слишком сильно для новичка,
// поэтому слабые уровни «очеловечены»: выбор из нескольких линий, случайные ходы и зевки.

export const BOTS = [
  {
    id: 'pawn', piece: 'p', name: 'Пешка', elo: 400,
    about: 'Только учится. Часто оставляет фигуры под боем.',
    skill: 0, depth: 1, multipv: 5, random: 0.3, blunder: 0.35, temp: 250,
  },
  {
    id: 'knight', piece: 'n', name: 'Конь', elo: 800,
    about: 'Знает правила и рвётся в атаку. Путается в тактике.',
    skill: 0, depth: 2, multipv: 5, random: 0.08, blunder: 0.2, temp: 150,
  },
  {
    id: 'bishop', piece: 'b', name: 'Слон', elo: 1200,
    about: 'Играет здраво, но не видит двойных ударов.',
    skill: 2, depth: 4, multipv: 4, random: 0, blunder: 0.1, temp: 80,
  },
  {
    id: 'rook', piece: 'r', name: 'Ладья', elo: 1600,
    about: 'Крепкий клубный игрок. Наказывает за зевки.',
    skill: 6, depth: 7, multipv: 3, random: 0, blunder: 0.04, temp: 40,
  },
  {
    id: 'queen', piece: 'q', name: 'Ферзь', elo: 2000,
    about: 'Сильный и точный. Ошибки почти не прощает.',
    skill: 12, depth: 10, multipv: 2, random: 0, blunder: 0, temp: 15,
  },
  {
    id: 'king', piece: 'k', name: 'Король', elo: 2500,
    about: 'Полная сила движка. Попробуй хотя бы свести вничью.',
    skill: 20, depth: 18, movetime: 1500, multipv: 1, random: 0, blunder: 0, temp: 0,
  },
];

export const botById = (id) => BOTS.find((b) => b.id === id) || BOTS[2];

/** Оценка линии в сантипешках с точки зрения бота (мат → очень большое число). */
export function lineValue(line) {
  if (line.mate != null) return line.mate > 0 ? 100000 - line.mate * 100 : -100000 - line.mate * 100;
  return line.cp;
}

/**
 * Выбирает ход бота.
 * @param lines линии Stockfish (с точки зрения бота)
 * @param legal ходы chess.js в verbose-виде
 * @param rng   генератор [0,1)
 */
export function pickBotMove(lines, legal, bot, rng = Math.random) {
  const toUci = (m) => m.from + m.to + (m.promotion || '');
  if (!legal.length) return null;
  if (!lines.length || rng() < bot.random) {
    const captures = legal.filter((m) => m.captured);
    const pool = captures.length && rng() < 0.5 ? captures : legal;
    return toUci(pool[Math.floor(rng() * pool.length)]);
  }
  const legalSet = new Set(legal.map(toUci));
  const valid = lines.filter((l) => legalSet.has(l.move));
  if (!valid.length) return toUci(legal[0]);
  if (valid.length > 1 && rng() < bot.blunder) {
    const rest = valid.slice(1);
    return rest[Math.floor(rng() * rest.length)].move;
  }
  if (!bot.temp || valid.length === 1) return valid[0].move;
  const best = lineValue(valid[0]);
  const weights = valid.map((l) => Math.exp(-Math.min(3000, best - lineValue(l)) / bot.temp));
  const total = weights.reduce((a, b) => a + b, 0);
  let x = rng() * total;
  for (let i = 0; i < valid.length; i++) {
    x -= weights[i];
    if (x <= 0) return valid[i].move;
  }
  return valid[0].move;
}

/** Сколько бот «думает» перед ходом, мс. */
export const thinkDelay = (bot, rng = Math.random) => (bot.movetime ? 200 : 450 + rng() * 750);

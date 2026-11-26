import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ruSan, plural, winPct, classifyByDrop, moveFeatures, moveReasons, evaluateMove, explainMove,
  pvMaterial, gainWord, describeThreat, nullMoveFen, hint, isSacrifice, summarize, formatEval, toWhite,
} from '../js/coach.js';
import { pickBotMove, BOTS } from '../js/bots.js';

test('русская нотация', () => {
  assert.equal(ruSan('Nf3'), 'Кf3');
  assert.equal(ruSan('Kxe2'), 'Крxe2');
  assert.equal(ruSan('e8=Q+'), 'e8=Ф+');
  assert.equal(ruSan('Bxc6'), 'Сxc6');
  assert.equal(ruSan('O-O-O'), 'O-O-O');
});

test('склонение числительных', () => {
  assert.equal(plural(1, 'ход', 'хода', 'ходов'), 'ход');
  assert.equal(plural(3, 'ход', 'хода', 'ходов'), 'хода');
  assert.equal(plural(5, 'ход', 'хода', 'ходов'), 'ходов');
  assert.equal(plural(11, 'ход', 'хода', 'ходов'), 'ходов');
  assert.equal(plural(21, 'ход', 'хода', 'ходов'), 'ход');
});

test('шанс на победу и форматирование оценки', () => {
  assert.equal(Math.round(winPct({ cp: 0 }, 'w')), 50);
  assert.ok(winPct({ cp: 300 }, 'w') > 75);
  assert.equal(Math.round(winPct({ cp: 300 }, 'w') + winPct({ cp: 300 }, 'b')), 100);
  assert.equal(winPct({ cp: null, mate: 3 }, 'w'), 100);
  assert.equal(winPct({ cp: null, mate: -2 }, 'w'), 0);
  assert.equal(formatEval({ cp: 134 }), '+1.3');
  assert.equal(formatEval({ cp: -80 }), '−0.8');
  assert.equal(formatEval({ cp: null, mate: -3 }), '−M3');
  // оценка со стороны чёрных → белые
  assert.deepEqual(toWhite({ cp: 50, mate: null }, 'b'), { cp: -50, mate: null });
});

test('пороги классификации', () => {
  assert.equal(classifyByDrop(0.2), 'best');
  assert.equal(classifyByDrop(1.5), 'excellent');
  assert.equal(classifyByDrop(4), 'good');
  assert.equal(classifyByDrop(7), 'inaccuracy');
  assert.equal(classifyByDrop(15), 'mistake');
  assert.equal(classifyByDrop(40), 'blunder');
});

test('вилка конём с шахом распознаётся', () => {
  const fen = 'r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1';
  const f = moveFeatures(fen, 'b5c7');
  assert.deepEqual(f.fork, ['k', 'r']);
  assert.ok(f.check);
  const { reasons } = moveReasons(fen, { move: 'b5c7', pv: ['b5c7', 'e8d7', 'c7a8'], cp: 500, mate: null });
  assert.match(reasons[0], /шах с нападением на ладью/);
});

test('мат в 1 находится и подсказка говорит о мате', () => {
  const fen = 'r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 2 3';
  const f = moveFeatures(fen, 'h5f7');
  assert.ok(f.mate);
  const analysis = { lines: [{ move: 'h5f7', pv: ['h5f7'], cp: null, mate: 1, multipv: 1 }] };
  assert.match(hint(fen, analysis, 1).text, /мат/);
  assert.equal(hint(fen, analysis, 2).from, 'h5');
  assert.match(hint(fen, analysis, 3).text, /^Фxf7#/);
});

test('материал по линии движка: выигрыш коня', () => {
  // чёрный конь на e5 не защищён, белый ферзь на e2 его забирает
  const fen = '4k3/8/8/4n3/8/8/4Q3/4K3 w - - 0 1';
  const g = pvMaterial(fen, ['e2e5', 'e8d7']);
  assert.equal(g.net, 3);
  assert.equal(gainWord(g), 'коня');
  const f = moveFeatures(fen, 'e2e5');
  assert.ok(f.winningCapture);
});

test('зевок ферзя: классификация и объяснение', () => {
  // белые ставят ферзя под пешку: Фd2-d6?? cxd6
  const fen = '4k3/2p5/8/8/8/8/3Q4/4K3 w - - 0 1';
  const before = {
    lines: [
      { move: 'd2d7', pv: ['d2d7', 'e8f8'], cp: 900, mate: null, multipv: 1 },
      { move: 'd2g5', pv: ['d2g5'], cp: 880, mate: null, multipv: 2 },
    ],
  };
  // после d2d6 ход чёрных: они берут ферзя, оценка с их стороны ~ +0.5
  const after = { lines: [{ move: 'c7d6', pv: ['c7d6', 'e1e2'], cp: 60, mate: null, multipv: 1 }] };
  const result = evaluateMove({ fenBefore: fen, uci: 'd2d6', before, after });
  assert.equal(result.cls, 'blunder');
  const text = explainMove({ fenBefore: fen, uci: 'd2d6', result, after });
  assert.match(text, /зевок/);
  assert.match(text, /cxd6 и выигрывает ферзя/);
  assert.match(text, /Лучше было Фd7/);
});

test('лучший ход и единственный ход', () => {
  const fen = '4k3/2p5/8/8/8/8/3Q4/4K3 w - - 0 1';
  const before = { lines: [{ move: 'd2g5', pv: ['d2g5'], cp: 900, mate: null, multipv: 1 }] };
  const r = evaluateMove({ fenBefore: fen, uci: 'd2g5', before, after: null });
  assert.equal(r.cls, 'best');
  // ферзь на d7 под боем короля — это жертва, если движок считает ход лучшим
  const before2 = { lines: [{ move: 'd2d7', pv: ['d2d7'], cp: 900, mate: null, multipv: 1 }] };
  assert.equal(evaluateMove({ fenBefore: fen, uci: 'd2d7', before: before2, after: null }).cls, 'sac');
  // у чёрного короля единственный ход Крa7
  const fen2 = 'k7/8/2K5/1Q6/8/8/8/8 b - - 0 1';
  const r2 = evaluateMove({
    fenBefore: fen2, uci: 'a8a7',
    before: { lines: [{ move: 'a8a7', pv: ['a8a7'], cp: null, mate: -2, multipv: 1 }] },
    after: { lines: [{ move: 'b5b6', pv: ['b5b6'], cp: null, mate: 2, multipv: 1 }] },
  });
  assert.equal(r2.cls, 'forced');
});

test('рокировка и превращение в объяснениях', () => {
  const castleFen = 'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1';
  const { reasons } = moveReasons(castleFen, { move: 'e1g1', pv: ['e1g1'], cp: 20, mate: null });
  assert.ok(reasons.some((r) => /рокировка/.test(r)));
  const promoFen = '8/4P1k1/8/8/8/8/8/4K3 w - - 0 1';
  const p = moveReasons(promoFen, { move: 'e7e8q', pv: ['e7e8q'], cp: 900, mate: null });
  assert.ok(p.reasons.some((r) => /превращение в ферзя/.test(r)));
});

test('защита от мата в один ход объясняется', () => {
  // чёрные грозят Фxf2#, Фe2 защищает
  const fen = 'rnb1k1nr/pppp1ppp/8/2b1p3/4P2q/8/PPPP1PPP/RNBQKBNR w KQkq - 2 4';
  const r = moveReasons(fen, { move: 'd1e2', pv: ['d1e2'], cp: -20, mate: null });
  assert.ok(r.reasons.some((x) => /защищает от мата Фxf2#/.test(x)), r.reasons.join(' | '));
  assert.match(hint(fen, { lines: [{ move: 'd1e2', pv: ['d1e2'], cp: -20, mate: null }] }, 1).text, /угрожает матом/);
  // ход, который не защищает, не получает эту причину
  const bad = moveReasons(fen, { move: 'a2a3', pv: ['a2a3'], cp: -900, mate: null });
  assert.ok(!bad.reasons.some((x) => /защищает от мата/.test(x)));
});

test('угроза соперника через нулевой ход', () => {
  // у белых конь на e5 без защиты, чёрный ферзь его бьёт
  const fen = '4k3/8/8/4N3/8/8/7q/4K3 w - - 0 1';
  assert.equal(nullMoveFen(fen).split(' ')[1], 'b');
  const threat = { lines: [{ move: 'h2e5', pv: ['h2e5', 'e1d1'], cp: 300, mate: null, multipv: 1 }] };
  const t = describeThreat(fen, threat);
  assert.ok(t);
  assert.match(t.text, /угрожает Фxe5\+ и выигрывает коня/);
  // под шахом угрозу не ищем — шах и есть угроза
  assert.equal(describeThreat('4k3/8/8/8/8/8/8/4K2q w - - 0 1', threat), null);
});

test('жертва фигуры распознаётся', () => {
  // слон берёт пешку f7 под защитой короля — отдаёт слона за пешку
  const fen = 'rnbqkbnr/pppp1ppp/8/4p3/2B1P3/8/PPPP1PPP/RNBQK1NR w KQkq - 0 2';
  assert.equal(isSacrifice(fen, 'c4f7'), true);
  assert.equal(isSacrifice(fen, 'g1f3'), false);
});

test('итог партии', () => {
  const s = summarize([
    { result: { cls: 'best', accuracy: 100 } },
    { result: { cls: 'blunder', accuracy: 20 } },
    { result: null },
  ]);
  assert.equal(s.counts.best, 1);
  assert.equal(s.counts.blunder, 1);
  assert.equal(s.accuracy, 60);
  assert.equal(s.moves, 2);
});

test('бот выбирает только легальные ходы', () => {
  const legal = [
    { from: 'e2', to: 'e4' }, { from: 'd2', to: 'd4' }, { from: 'g1', to: 'f3' },
  ];
  const lines = [
    { move: 'e2e4', cp: 30 }, { move: 'd2d4', cp: 25 }, { move: 'a2a4', cp: -10 },
  ];
  let seed = 1;
  const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (const bot of BOTS) {
    for (let i = 0; i < 50; i++) {
      const mv = pickBotMove(lines, legal, bot, rng);
      assert.ok(['e2e4', 'd2d4', 'g1f3'].includes(mv), `${bot.id}: ${mv}`);
    }
  }
  // сильнейший бот всегда играет лучшую линию
  assert.equal(pickBotMove(lines, legal, BOTS.at(-1), rng), 'e2e4');
});

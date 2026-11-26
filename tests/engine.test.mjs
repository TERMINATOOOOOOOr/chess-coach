// Интеграция с настоящим Stockfish: тот же engine.js, что в браузере, но воркер из worker_threads.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Worker } from 'node:worker_threads';
import { Chess } from '../vendor/chess.js';
import { Engine } from '../js/engine.js';
import { evaluateMove, explainMove, describeThreat, nullMoveFen, hint } from '../js/coach.js';
import { pickBotMove, BOTS } from '../js/bots.js';

const src = fs.readFileSync(new URL('../vendor/stockfish.js', import.meta.url), 'utf8');
const prefix =
  "const {parentPort}=require('worker_threads');globalThis.postMessage=(m)=>parentPort.postMessage(m);" +
  'parentPort.on("message",(d)=>globalThis.onmessage({data:d}));\n';

const workers = [];
test.after(() => Promise.all(workers.map((w) => w.terminate())));

function nodeWorker() {
  const w = new Worker(prefix + src, { eval: true });
  workers.push(w);
  return {
    postMessage: (m) => w.postMessage(m),
    set onmessage(fn) {
      w.on('message', (d) => fn({ data: d }));
    },
  };
}

const engine = new Engine(nodeWorker, { Contempt: 0, 'Analysis Contempt': 'Off' });

test('зевок слона в дебюте: «Зевок» и объяснение', { timeout: 60000 }, async () => {
  const fen = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';
  const before = await engine.analyse(fen, { depth: 12, multipv: 3 });
  assert.equal(before.lines.length, 3);
  const c = new Chess(fen);
  c.move({ from: 'f1', to: 'a6' });
  const after = await engine.analyse(c.fen(), { depth: 12, multipv: 1 });
  const result = evaluateMove({ fenBefore: fen, uci: 'f1a6', before, after });
  assert.equal(result.cls, 'blunder');
  const text = explainMove({ fenBefore: fen, uci: 'f1a6', result, after });
  assert.match(text, /выигрывает слона/);
  console.log('   тренер:', text);
});

test('лучший ход движка получает «Лучший ход»', { timeout: 60000 }, async () => {
  const fen = 'r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 2 3';
  const before = await engine.analyse(fen, { depth: 10, multipv: 3 });
  assert.equal(before.lines[0].move, 'h5f7');
  assert.equal(before.lines[0].mate, 1);
  const result = evaluateMove({ fenBefore: fen, uci: 'h5f7', before, after: null });
  assert.equal(result.cls, 'best');
  assert.match(hint(fen, before, 1).text, /мат/);
});

test('угроза мата видна через нулевой ход', { timeout: 60000 }, async () => {
  // чёрные сыграли Кc6, белые угрожают Фxf7# — ход чёрных
  const fen = 'r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 3 3';
  const threat = await engine.analyse(nullMoveFen(fen), { depth: 8, multipv: 1 });
  const t = describeThreat(fen, threat);
  assert.ok(t, 'угроза должна найтись');
  assert.match(t.text, /мата/);
  console.log('   угроза:', t.text);
});

test('все боты делают легальный ход', { timeout: 120000 }, async () => {
  const fen = 'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';
  const c = new Chess(fen);
  const legal = c.moves({ verbose: true });
  for (const bot of BOTS) {
    await engine.setOption('Skill Level', bot.skill);
    const a = await engine.analyse(fen, { depth: Math.min(bot.depth, 10), multipv: bot.multipv });
    const mv = pickBotMove(a.lines, legal, bot);
    assert.ok(legal.some((m) => m.from + m.to + (m.promotion || '') === mv), `${bot.id}: ${mv}`);
  }
  await engine.setOption('Skill Level', 20);
});

test('отмена анализа не вешает очередь', { timeout: 60000 }, async () => {
  const p1 = engine.analyse('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', { depth: 30 });
  const p2 = engine.analyse('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1', { depth: 30 });
  setTimeout(() => engine.cancel(), 300);
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.cancelled, true);
  assert.equal(r2.cancelled, true);
  const r3 = await engine.analyse('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', { depth: 6 });
  assert.equal(r3.cancelled, false);
  assert.ok(r3.bestmove);
});

// Shoh: партия с ботом и ИИ-тренер рядом.
import { Chess } from '../vendor/chess.js';
import { Engine, stockfishWorkerFactory } from './engine.js';
import { Board } from './board.js';
import { BOTS, botById, pickBotMove, thinkDelay } from './bots.js';
import {
  CLASSES, VALUE, ruSan, uciToMove, toWhite, winPct, formatEval, evaluateMove, explainMove,
  describeThreat, nullMoveFen, hint, shortReason, summarize, opposite,
} from './coach.js';

// тренер в позиции игрока считает глубже любого бота, иначе «лучший ход» против сильных ботов проигрывает
const COACH = { depth: 16, movetime: 2500 };
const AFTER = { depth: 12, movetime: 3000 };
const THREAT = { depth: 9, movetime: 1500 };

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem('shoh.' + k);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem('shoh.' + k, JSON.stringify(v));
    } catch { /* приватный режим — не страшно */ }
  },
};

// ───────────────────────── состояние ─────────────────────────

const state = {
  game: new Chess(),
  bot: botById(store.get('bot', 'bishop')),
  colorChoice: store.get('color', 'w'),
  player: 'w',
  entries: [],
  token: 0,
  started: false,
  over: null,
  analysis: null, // анализ текущей позиции (ход игрока)
  threat: null,
  hintTier: 0,
  hintsUsed: 0,
  hintMove: null,
  evalWhite: { cp: 0, mate: null },
  botThinking: false,
  coachBusy: 0,
  settings: {
    top: store.get('top', false),
    threat: store.get('threat', true),
    comment: store.get('comment', true),
  },
  cache: new Map(),
};

const makeWorker = stockfishWorkerFactory();
const botEngine = new Engine(makeWorker);
// тренеру нужна честная оценка без «презрения к ничьей»
const coachEngine = new Engine(makeWorker, { Contempt: 0, 'Analysis Contempt': 'Off' });

const board = new Board($('board'), {
  onMove: (m) => onUserMove(m),
  legalMoves: (sq) =>
    state.game.moves({ square: sq, verbose: true }).map((m) => ({ to: m.to, promotion: m.promotion, ep: m.flags.includes('e') })),
});

// ───────────────────────── анализ тренера ─────────────────────────

/** uci первых n ходов партии — история для движка. */
const historyMoves = (n = state.entries.length) => state.entries.slice(0, n).map((e) => e.uci);

/**
 * Анализ для тренера. fen — текущая позиция; moves — история от state.startFen
 * (null для искусственных позиций вроде нулевого хода).
 */
function coachAnalyse(fen, multipv, opts, moves = null) {
  const key = moves ? `${state.startFen}|${moves.join(' ')}|${multipv}|${opts.depth}` : `${fen}|${multipv}|${opts.depth}`;
  if (state.cache.has(key)) return state.cache.get(key);
  state.coachBusy++;
  renderCoachStatus();
  const req = moves ? coachEngine.analyse(state.startFen, { ...opts, multipv, moves }) : coachEngine.analyse(fen, { ...opts, multipv });
  const p = req.then((r) => {
    state.coachBusy = Math.max(0, state.coachBusy - 1);
    renderCoachStatus();
    if (r.cancelled) state.cache.delete(key);
    return { ...r, fen };
  });
  state.cache.set(key, p);
  return p;
}

// ───────────────────────── ход партии ─────────────────────────

async function startGame({ fen = null } = {}) {
  const t = ++state.token;
  botEngine.newGame();
  coachEngine.newGame();
  state.cache.clear();
  const c = state.colorChoice;
  state.player = c === 'r' ? (Math.random() < 0.5 ? 'w' : 'b') : c;
  state.game = fen ? new Chess(fen) : new Chess();
  state.startFen = state.game.fen();
  state.entries = [];
  state.over = null;
  state.started = true;
  state.hintsUsed = 0;
  state.evalWhite = { cp: 0, mate: null };
  resetTurnUi();
  await botEngine.setOption('Skill Level', state.bot.skill);
  if (t !== state.token) return; // за это время успели начать другую партию
  board.setOrientation(state.player);
  board.setBadge(null);
  setEval(state.evalWhite);
  syncBoard(false);
  renderAll();
  say({
    text: `Играем против бота «${state.bot.name}» (≈${state.bot.elo}). Ты ${state.player === 'w' ? 'белыми' : 'чёрными'}. ` +
      'Если застрянешь, жми «Подсказка»: сначала дам идею, потом покажу фигуру и только потом сам ход.',
  });
  nextTurn();
}

function nextTurn() {
  if (checkGameOver()) return;
  if (state.game.turn() === state.player) playerTurn();
  else botTurn();
}

function resetTurnUi() {
  state.analysis = null;
  state.threat = null;
  state.hintTier = 0;
  state.hintMove = null;
  board.clearMarks();
  board.setArrows([]);
  renderHintPips();
  renderTopMoves();
  setWarn(null);
  setChance(null);
}

async function playerTurn() {
  const t = state.token;
  const fen = state.game.fen();
  // результат анализа применяем, только если позиция за это время не изменилась
  const alive = () => t === state.token && state.game.fen() === fen;
  board.setInteractive(state.player);
  renderStrips();
  const a = await coachAnalyse(fen, 3, COACH, historyMoves());
  if (!alive() || a.cancelled) return;
  state.analysis = a;
  if (a.lines[0]) {
    const now = toWhite(a.lines[0], state.game.turn());
    setEval(now);
    // бот ошибся? сравниваем с оценкой после нашего прошлого хода
    const mine = state.entries.filter((e) => e.color === state.player).at(-1);
    const botMove = state.entries.at(-1);
    if (mine && mine.result && botMove && botMove.color !== state.player) {
      const gain = winPct(now, state.player) - winPct(mine.result.afterScore, state.player);
      if (gain >= 15 && winPct(now, state.player) >= 60) {
        setChance(`Соперник сыграл ${ruSan(botMove.san)} и ошибся. Здесь можно выиграть: поищи, как наказать.`);
      }
    }
  }
  renderTopMoves();
  refreshArrows();
  if (state.hintTier > 0) showHint(); // подсказку просили, пока тренер думал

  if (!state.game.inCheck()) {
    const th = await coachAnalyse(nullMoveFen(fen), 1, THREAT);
    if (!alive() || th.cancelled) return;
    state.threat = describeThreat(fen, th);
    showThreat();
  }
}

async function onUserMove({ from, to, promotion }) {
  if (state.over || !state.started || state.game.turn() !== state.player) return;
  const fenBefore = state.game.fen();
  let mv;
  try {
    mv = state.game.move({ from, to, promotion });
  } catch {
    syncBoard();
    return;
  }
  const uci = mv.from + mv.to + (mv.promotion || '');
  const entry = {
    san: mv.san, uci, color: mv.color, fenBefore, fenAfter: state.game.fen(), result: null, comment: null,
    movesBefore: historyMoves(),
  };
  state.entries.push(entry);
  board.setInteractive(null);
  resetTurnUi();
  board.setBadge(null);
  syncBoard();
  renderAll();
  setRetry(false);
  entry.done = evaluatePlayerMove(entry, state.token);
  nextTurn();
}

async function evaluatePlayerMove(entry, t) {
  const before = await coachAnalyse(entry.fenBefore, 3, COACH, entry.movesBefore);
  const after = new Chess(entry.fenAfter);
  const afterA = after.isGameOver() ? null : await coachAnalyse(entry.fenAfter, 1, AFTER, [...entry.movesBefore, entry.uci]);
  if (t !== state.token || before.cancelled || (afterA && afterA.cancelled)) return;
  const result = evaluateMove({ fenBefore: entry.fenBefore, uci: entry.uci, before, after: afterA });
  if (!result) return;
  entry.result = result;
  entry.comment = explainMove({ fenBefore: entry.fenBefore, uci: entry.uci, result, after: afterA });
  if (afterA && afterA.lines[0] && state.game.fen() === entry.fenAfter) setEval(toWhite(afterA.lines[0], after.turn()));
  renderMoves();
  renderAccuracy();
  const isLast = state.entries.at(-1) === entry;
  if (isLast) board.setBadge(entry.uci.slice(2, 4), result.cls, CLASSES[result.cls].sym);
  const bad = ['inaccuracy', 'mistake', 'blunder'].includes(result.cls);
  if (state.settings.comment || bad) {
    say({ cls: result.cls, text: entry.comment });
    setRetry(['mistake', 'blunder'].includes(result.cls) && !state.over);
  }
}

async function botTurn() {
  const t = state.token;
  const fen = state.game.fen();
  const legal = state.game.moves({ verbose: true });
  const bot = state.bot;
  state.botThinking = true;
  renderStrips();
  const last = state.entries.at(-1);
  const [a] = await Promise.all([
    botEngine.analyse(state.startFen, {
      depth: bot.depth, multipv: bot.multipv, movetime: bot.movetime || 0, moves: historyMoves(),
    }),
    sleep(thinkDelay(bot)),
    // бот ждёт, пока тренер оценит ход игрока (но не дольше 5 с), и даёт вердикту повисеть
    last && last.done ? Promise.race([last.done.then(() => sleep(450)), sleep(5000)]) : null,
  ]);
  if (t !== state.token || a.cancelled) return;
  state.botThinking = false;
  const uci = pickBotMove(a.lines, legal, bot) || a.bestmove;
  const mv = state.game.move(uciToMove(uci));
  state.entries.push({ san: mv.san, uci, color: mv.color, fenBefore: fen, fenAfter: state.game.fen(), result: null });
  // значок оценки остаётся на нашем ходе, пока бот не встал на это поле
  if (board.badge && board.badge.sq === mv.to) board.setBadge(null);
  syncBoard();
  renderAll();
  nextTurn();
}

function checkGameOver() {
  const g = state.game;
  if (!g.isGameOver()) return false;
  let winner = null;
  let reason;
  if (g.isCheckmate()) {
    winner = opposite(g.turn());
    reason = 'Мат';
  } else if (g.isStalemate()) reason = 'Пат';
  else if (g.isInsufficientMaterial()) reason = 'Недостаточно материала';
  else if (g.isThreefoldRepetition()) reason = 'Троекратное повторение';
  else reason = 'Правило 50 ходов';
  finish(winner, reason);
  return true;
}

async function finish(winner, reason) {
  state.over = { winner, reason };
  board.setInteractive(null);
  state.botThinking = false;
  renderStrips();
  setRetry(false);
  const last = state.entries.filter((e) => e.color === state.player).at(-1);
  if (last && last.done) await Promise.race([last.done, sleep(6000)]);
  const t = state.token;
  await sleep(winner === state.player ? 700 : 500);
  if (t !== state.token || !state.over) return;
  showResult();
}

function resign() {
  if (!state.started || state.over) return;
  state.token++;
  botEngine.cancel();
  coachEngine.cancel();
  finish(opposite(state.player), 'Вы сдались');
}

function takeBack() {
  if (!state.started) return;
  if (!state.entries.some((e) => e.color === state.player)) return;
  if (state.over && state.over.reason === 'Вы сдались') return;
  state.token++;
  botEngine.cancel();
  coachEngine.cancel();
  state.botThinking = false;
  state.over = null;
  while (state.entries.length) {
    const e = state.entries.pop();
    state.game.undo();
    if (e.color === state.player) break;
  }
  $('result').open && $('result').close();
  resetTurnUi();
  board.setBadge(null);
  setRetry(false);
  syncBoard();
  renderAll();
  say({ text: 'Ход взят назад. Подумай ещё раз: что хочет соперник и какие фигуры у тебя без защиты?' });
  nextTurn();
}

// ───────────────────────── подсказки и стрелки ─────────────────────────

function requestHint() {
  if (!state.started || state.over || state.game.turn() !== state.player) return;
  state.hintTier = Math.min(3, state.hintTier + 1);
  state.hintsUsed++;
  renderHintPips();
  renderButtons();
  if (!state.analysis) {
    say({ cls: 'hint', label: `Подсказка ${state.hintTier}/3`, text: 'Секунду, смотрю позицию…' });
    return; // покажем, когда анализ будет готов
  }
  showHint();
}

function showHint() {
  const a = state.analysis;
  if (!a || !a.lines.length || a.fen !== state.game.fen()) return;
  const h = hint(state.game.fen(), a, state.hintTier);
  board.setMarks('hint-from', h.from ? [h.from] : []);
  state.hintMove = state.hintTier >= 3 ? { from: h.from, to: h.to } : null;
  refreshArrows();
  say({ cls: 'hint', label: `Подсказка ${state.hintTier}/3`, text: h.text });
}

function showThreat() {
  const th = state.threat;
  if (!state.settings.threat || !th) {
    setWarn(null);
    board.setMarks('threat', []);
    refreshArrows();
    return;
  }
  setWarn(th.text);
  board.setMarks('threat', th.square ? [th.square] : []);
  refreshArrows();
}

function refreshArrows() {
  const list = [];
  const a = state.analysis;
  const myTurn = state.started && !state.over && state.game.turn() === state.player;
  if (myTurn && state.settings.top && a) {
    a.lines.slice(0, 3).forEach((l, i) => {
      const m = uciToMove(l.move);
      list.push({ from: m.from, to: m.to, kind: ['best', 'alt', 'alt2'][i] });
    });
  }
  if (myTurn && state.hintMove) list.push({ ...state.hintMove, kind: 'hint' });
  if (myTurn && state.settings.threat && state.threat && state.threat.move) {
    const m = uciToMove(state.threat.move);
    list.push({ from: m.from, to: m.to, kind: 'threat' });
  }
  board.setArrows(list);
}

// ───────────────────────── рендер ─────────────────────────

function syncBoard(animate = true) {
  const g = state.game;
  const h = g.history({ verbose: true });
  const last = h.at(-1);
  let check = null;
  if (g.inCheck()) {
    for (const row of g.board()) for (const p of row) if (p && p.type === 'k' && p.color === g.turn()) check = p.square;
  }
  board.setPosition(g.board(), { lastMove: last ? { from: last.from, to: last.to } : null, check, animate });
}

function renderAll() {
  renderStrips();
  renderMoves();
  renderAccuracy();
  renderHintPips();
  renderButtons();
}

function setEval(scoreWhite) {
  state.evalWhite = scoreWhite;
  const bar = $('evalbar');
  const w = winPct(scoreWhite, 'w');
  bar.querySelector('.evalbar-fill').style.height = `${Math.max(3, Math.min(97, w))}%`;
  bar.classList.toggle('flipped', board.orientation === 'b');
  bar.classList.toggle('black-ahead', w < 50);
  const txt = formatEval(scoreWhite).replace(/^[+−]/, '');
  bar.querySelector('.evalbar-num').textContent = txt;
  bar.setAttribute('aria-label', `Оценка позиции: ${formatEval(scoreWhite)}`);
  $('coach-eval').textContent = formatEval(scoreWhite);
}

function say({ cls = null, label = null, text }) {
  const tag = $('bubble-tag');
  if (cls) {
    const info = cls === 'hint' ? { sym: '?', label: label || 'Подсказка' } : CLASSES[cls];
    tag.className = `bubble-tag c-${cls}`;
    tag.innerHTML = '';
    const s = document.createElement('span');
    s.className = 'sym';
    s.textContent = info.sym;
    tag.append(s, document.createTextNode(label || info.label));
    tag.hidden = false;
  } else {
    tag.hidden = true;
  }
  $('bubble-text').textContent = text;
  const b = $('bubble');
  b.classList.remove('fresh');
  void b.offsetWidth;
  b.classList.add('fresh');
}

function setWarn(text) {
  const w = $('bubble-warn');
  w.hidden = !text;
  w.textContent = text || '';
}

function setChance(text) {
  const w = $('bubble-chance');
  w.hidden = !text;
  w.textContent = text || '';
}

function setRetry(show) {
  $('btn-retry').hidden = !show;
}

function renderCoachStatus() {
  const el = $('coach-status');
  const busy = state.coachBusy > 0;
  el.classList.toggle('busy', busy);
  el.innerHTML = busy ? 'думает <span class="dots"><i></i><i></i><i></i></span>' : 'смотрит за партией';
}

function renderHintPips() {
  const pips = $('hint-pips').children;
  for (let i = 0; i < 3; i++) pips[i].classList.toggle('on', i < state.hintTier);
}

function renderButtons() {
  const myTurn = state.started && !state.over && state.game.turn() === state.player;
  $('btn-hint').disabled = !myTurn || state.hintTier >= 3;
  $('btn-undo').disabled = !state.started || !state.entries.some((e) => e.color === state.player) ||
    (state.over && state.over.reason === 'Вы сдались');
  $('btn-resign').disabled = !state.started || !!state.over;
}

function renderTopMoves() {
  const ol = $('topmoves');
  const a = state.analysis;
  const show = state.settings.top && a && a.lines.length && !state.over && state.game.turn() === state.player;
  ol.hidden = !show;
  ol.innerHTML = '';
  if (!show) return;
  const fen = state.game.fen();
  const stm = state.game.turn();
  a.lines.slice(0, 3).forEach((l, i) => {
    const li = document.createElement('li');
    const san = ruSan(new Chess(fen).move(uciToMove(l.move)).san);
    li.innerHTML = `<span class="n">${i + 1}</span><span class="mv"></span><span class="ev"></span><span class="why"></span>`;
    li.querySelector('.mv').textContent = san;
    li.querySelector('.ev').textContent = formatEval(toWhite(l, stm));
    li.querySelector('.why').textContent = shortReason(fen, l);
    ol.appendChild(li);
  });
}

function pieceEl(color, type, cls = '') {
  const d = document.createElement('div');
  d.className = `pc ${color}${type} ${cls}`;
  return d;
}

function capturedBy(color) {
  // фигуры соперника, которых не хватает на доске
  const start = { p: 8, n: 2, b: 2, r: 2, q: 1 };
  const opp = opposite(color);
  const have = { p: 0, n: 0, b: 0, r: 0, q: 0 };
  for (const row of state.game.board()) for (const p of row) if (p && p.color === opp && p.type !== 'k') have[p.type]++;
  const out = [];
  for (const t of ['q', 'r', 'b', 'n', 'p']) for (let i = 0; i < Math.max(0, start[t] - have[t]); i++) out.push(t);
  return out;
}

function materialOf(color) {
  let s = 0;
  for (const row of state.game.board()) for (const p of row) if (p && p.color === color) s += VALUE[p.type];
  return s;
}

function renderStrip(el, side) {
  const isBot = side !== state.player;
  el.innerHTML = '';
  const ava = document.createElement('div');
  ava.className = 'ava' + (isBot ? '' : ' you');
  if (isBot) ava.appendChild(pieceEl('w', state.bot.piece));
  else ava.textContent = 'Вы';
  const who = document.createElement('div');
  who.className = 'who';
  const b = document.createElement('b');
  b.textContent = isBot ? `Бот «${state.bot.name}»` : 'Вы';
  const small = document.createElement('small');
  small.textContent = isBot ? `≈${state.bot.elo} · ${side === 'w' ? 'белые' : 'чёрные'}` : side === 'w' ? 'белые' : 'чёрные';
  who.append(b, small);
  const caps = document.createElement('div');
  caps.className = 'caps';
  for (const t of capturedBy(side)) caps.appendChild(pieceEl(opposite(side), t));
  const adv = materialOf(side) - materialOf(opposite(side));
  if (adv > 0) {
    const s = document.createElement('span');
    s.className = 'adv';
    s.textContent = `+${adv}`;
    caps.appendChild(s);
  }
  el.append(ava, who, caps);
  if (isBot && state.botThinking && !state.over) {
    const th = document.createElement('div');
    th.className = 'thinking';
    th.innerHTML = 'думает <span class="dots"><i></i><i></i><i></i></span>';
    el.appendChild(th);
  }
}

function renderStrips() {
  const top = board.orientation === 'w' ? 'b' : 'w';
  renderStrip($('strip-top'), top);
  renderStrip($('strip-bottom'), opposite(top));
  renderButtons();
}

function renderMoves() {
  const ol = $('movelist');
  ol.innerHTML = '';
  if (!state.entries.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Партия ещё не началась.';
    ol.appendChild(li);
    return;
  }
  const firstColor = state.entries[0].color;
  let i = 0;
  let no = +state.entries[0].fenBefore.split(' ')[5] || 1;
  while (i < state.entries.length) {
    const li = document.createElement('li');
    const n = document.createElement('span');
    n.className = 'no';
    n.textContent = `${no}.`;
    li.appendChild(n);
    const pair = [];
    if (i === 0 && firstColor === 'b') pair.push(null);
    while (pair.length < 2 && i < state.entries.length) pair.push(state.entries[i++]);
    for (const e of pair) li.appendChild(moveCell(e));
    if (pair.length < 2) li.appendChild(moveCell(null));
    ol.appendChild(li);
    no++;
  }
  ol.scrollTop = ol.scrollHeight;
}

function moveCell(e) {
  const s = document.createElement('span');
  s.className = 'mv';
  if (!e) return s;
  if (e === state.entries.at(-1)) s.classList.add('last');
  s.appendChild(document.createTextNode(ruSan(e.san)));
  if (e.result) {
    const sym = document.createElement('span');
    sym.className = `sym c-${e.result.cls}`;
    sym.textContent = CLASSES[e.result.cls].sym;
    sym.title = CLASSES[e.result.cls].label;
    s.appendChild(sym);
  }
  return s;
}

function renderAccuracy() {
  const sum = summarize(state.entries.filter((e) => e.color === state.player));
  $('acc-live').textContent = sum.accuracy == null ? '' : `точность ${Math.round(sum.accuracy)}%`;
}

// ───────────────────────── окна ─────────────────────────

function renderBots() {
  const wrap = $('bots');
  wrap.innerHTML = '';
  for (const b of BOTS) {
    const label = document.createElement('label');
    label.className = 'bot';
    label.innerHTML = `<input type="radio" name="bot" value="${b.id}"><span class="bot-card"><span class="bot-ava"></span><span class="bot-name"><b></b><span></span></span><span class="bot-about"></span></span>`;
    label.querySelector('input').checked = b.id === state.bot.id;
    label.querySelector('.bot-ava').appendChild(pieceEl('w', b.piece));
    label.querySelector('.bot-name b').textContent = b.name;
    label.querySelector('.bot-name span').textContent = `≈${b.elo}`;
    label.querySelector('.bot-about').textContent = b.about;
    wrap.appendChild(label);
  }
}

function openSetup({ color = null } = {}) {
  renderBots();
  const form = $('setup-form');
  const fromPos = !!state.pendingFen;
  $('setup-eyebrow').textContent = fromPos ? 'Доиграть позицию из партии' : 'Новая партия';
  $('setup-title').textContent = fromPos ? 'С кем доиграем?' : 'С кем сыграем?';
  const pick = color || state.colorChoice;
  for (const r of form.elements.color) {
    r.checked = r.value === pick;
    r.disabled = fromPos && r.value !== pick; // в позиции из партии играем за свой цвет
  }
  $('setup').returnValue = '';
  $('setup').showModal();
}

$('setup').addEventListener('close', () => {
  const fen = state.pendingFen;
  state.pendingFen = null;
  if ($('setup').returnValue !== 'start') {
    $('btn-choose').hidden = state.started;
    return;
  }
  const form = $('setup-form');
  state.bot = botById(form.elements.bot.value);
  state.colorChoice = form.elements.color.value;
  store.set('bot', state.bot.id);
  if (!fen) store.set('color', state.colorChoice);
  $('btn-choose').hidden = true;
  startGame({ fen });
});

function showResult() {
  const { winner, reason } = state.over;
  const sum = summarize(state.entries.filter((e) => e.color === state.player));
  $('result-reason').textContent = reason;
  $('result-title').textContent = winner === null ? 'Ничья' : winner === state.player ? 'Победа!' : 'Поражение';
  const acc = sum.accuracy == null ? null : Math.round(sum.accuracy);
  $('acc-num').textContent = acc == null ? '—' : `${acc}%`;
  $('acc-ring').style.setProperty('--p', acc || 0);
  const ul = $('result-counts');
  ul.innerHTML = '';
  for (const k of ['sac', 'best', 'excellent', 'good', 'inaccuracy', 'mistake', 'blunder']) {
    const li = document.createElement('li');
    li.className = `c-${k}`;
    li.innerHTML = `<span class="sym"></span><span></span><b></b>`;
    li.querySelector('.sym').textContent = CLASSES[k].sym;
    li.children[1].textContent = CLASSES[k].label;
    li.querySelector('b').textContent = sum.counts[k];
    ul.appendChild(li);
  }
  const bad = sum.counts.blunder + sum.counts.mistake;
  let note;
  if (!sum.moves) note = 'Партия была слишком короткой для разбора.';
  else if (bad === 0) note = 'Ни одной ошибки или зевка — чистая партия.';
  else note = `Ошибок и зевков: ${bad}. Чаще всего их спасает простой вопрос перед ходом: «что бьёт соперник после моего хода?»`;
  if (state.hintsUsed) note += ` Подсказок использовано: ${state.hintsUsed}.`;
  $('result-note').textContent = note;
  $('result').returnValue = '';
  $('result').showModal();
}

$('result').addEventListener('close', () => {
  const v = $('result').returnValue;
  if (v === 'rematch') startGame();
  else if (v === 'other') openSetup();
});

// ───────────────────────── кнопки ─────────────────────────

$('btn-new').addEventListener('click', openSetup);
$('btn-hint').addEventListener('click', requestHint);
$('btn-undo').addEventListener('click', takeBack);
$('btn-retry').addEventListener('click', takeBack);
$('btn-flip').addEventListener('click', () => {
  board.setOrientation(opposite(board.orientation));
  setEval(state.evalWhite);
  renderStrips();
});

let resignTimer = null;
$('btn-resign').addEventListener('click', () => {
  const btn = $('btn-resign');
  if (btn.classList.contains('confirm')) {
    clearTimeout(resignTimer);
    btn.classList.remove('confirm');
    btn.textContent = 'Сдаться';
    resign();
    return;
  }
  btn.classList.add('confirm');
  btn.textContent = 'Точно сдаться?';
  resignTimer = setTimeout(() => {
    btn.classList.remove('confirm');
    btn.textContent = 'Сдаться';
  }, 3000);
});

for (const [id, key] of [['tg-top', 'top'], ['tg-threat', 'threat'], ['tg-comment', 'comment']]) {
  const el = $(id);
  el.checked = state.settings[key];
  el.addEventListener('change', () => {
    state.settings[key] = el.checked;
    store.set(key, el.checked);
    renderTopMoves();
    showThreat();
  });
}

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea') || document.querySelector('dialog[open]')) return;
  if (document.body.dataset.screen && document.body.dataset.screen !== 'play') return;
  if (e.key === 'h' || e.key === 'р') requestHint();
  if ((e.key === 'z' || e.key === 'я') && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    takeBack();
  }
});

// ───────────────────────── старт ─────────────────────────

syncBoard(false);
setEval(state.evalWhite);
renderAll();
renderCoachStatus();
$('btn-choose').addEventListener('click', () => openSetup());

/** Экран «Играть» открыт: если партии ещё нет — предложить соперника. */
export function enterPlay() {
  $('btn-choose').hidden = state.started;
  if (!state.started && !$('setup').open && !$('result').open) openSetup();
}

/** «Доиграть отсюда»: позиция из разбора партии, игрок за color. */
export function playFromPosition(fen, color) {
  state.pendingFen = fen;
  openSetup({ color });
}

/** Идёт партия с ботом (на это время фоновый разбор встаёт на паузу). */
export const isPlaying = () => state.started && !state.over;

// для e2e-тестов: старт из произвольной позиции
window.__shoh = {
  state,
  start(fen, color = 'w', botId = 'pawn') {
    state.bot = botById(botId);
    state.colorChoice = color;
    state.started = true;
    state.pendingFen = null;
    if ($('setup').open) $('setup').close('hook');
    if ($('result').open) $('result').close('hook');
    return startGame({ fen });
  },
};

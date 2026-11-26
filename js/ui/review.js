// Экран «Разбор партии»: листание ходов, график, комментарии тренера, ключевые моменты.
import { Chess } from '../../vendor/chess.js';
import { Board } from '../board.js';
import { CLASSES, formatEval, winPct, uciToMove } from '../coach.js';
import { gamePositions, winSeries, ERROR_TYPES } from '../review.js';
import { formatTimeControl, timeClassName } from '../chesscom.js';
import { db } from '../store.js';
import { enqueueReview, reviewProgress, isReviewed, reviewingId } from '../reviewer.js';
import { byId, h, svgEl, on, formatDate } from './dom.js';
import { currentScreen } from './tabs.js';
import { opponentOf } from './games.js';

const RESULT = { win: 'Победа', loss: 'Поражение', draw: 'Ничья', white: '1–0', black: '0–1', unknown: '' };
const st = { game: null, pos: null, ply: 0, board: null, onPlayFrom: null };

const myColor = () => st.game?.myColor || 'w';
const rows = () => (isReviewed(st.game) ? st.game.review.plies : null);

function fenAt(i) {
  if (i === 0) return st.pos.startFen;
  return st.pos.plies[i - 1].fenAfter;
}

function boardOf(fen) {
  return new Chess(fen).board();
}

function setEvalBar(score) {
  const bar = byId('review-evalbar');
  const w = score ? winPct(score, 'w') : 50;
  bar.querySelector('.evalbar-fill').style.height = `${Math.max(3, Math.min(97, w))}%`;
  bar.classList.toggle('flipped', myColor() === 'b');
  bar.classList.toggle('black-ahead', w < 50);
  bar.querySelector('.evalbar-num').textContent = score ? formatEval(score).replace(/^[+−]/, '') : '';
}

function go(i) {
  if (!st.pos) return;
  st.ply = Math.max(0, Math.min(st.pos.plies.length, i));
  renderPosition();
}

function renderPosition() {
  const i = st.ply;
  const fen = fenAt(i);
  const mv = i > 0 ? st.pos.plies[i - 1] : null;
  const c = new Chess(fen);
  let check = null;
  if (c.inCheck()) for (const row of c.board()) for (const p of row) if (p && p.type === 'k' && p.color === c.turn()) check = p.square;
  st.board.setPosition(boardOf(fen), {
    lastMove: mv ? { from: mv.uci.slice(0, 2), to: mv.uci.slice(2, 4) } : null,
    check,
  });
  byId('rv-pos').textContent = `${i} / ${st.pos.plies.length}`;
  byId('rv-prev').disabled = byId('rv-first').disabled = i === 0;
  byId('rv-next').disabled = byId('rv-last').disabled = i === st.pos.plies.length;

  const r = rows();
  const row = r && i > 0 ? r[i - 1] : null;
  // значок класса и стрелка «лучше было»
  if (row && row.cls) st.board.setBadge(row.uci.slice(2, 4), row.cls, CLASSES[row.cls].sym);
  else st.board.setBadge(null);
  const arrows = [];
  if (row && row.best && ['inaccuracy', 'mistake', 'blunder', 'good'].includes(row.cls)) {
    const b = uciToMove(row.best.uci);
    arrows.push({ from: b.from, to: b.to, kind: 'best' });
  }
  st.board.setArrows(arrows);
  setEvalBar(r ? (i === 0 ? st.game.review.evalStart : r[i - 1].evalAfter) : null);

  // комментарий тренера
  const tag = byId('rv-tag');
  const text = byId('rv-text');
  const extra = byId('rv-extra');
  extra.innerHTML = '';
  if (!mv) {
    tag.hidden = true;
    text.textContent = r
      ? 'Начальная позиция. Листай ходы стрелками или свайпом по доске, ошибки отмечены на графике.'
      : 'Тренер разбирает партию. Ходы уже можно листать.';
  } else if (row && row.cls) {
    tag.hidden = false;
    tag.className = `bubble-tag c-${row.cls}`;
    tag.innerHTML = '';
    const who = row.color === myColor() ? '' : ' соперника';
    tag.append(h('span.sym', {}, CLASSES[row.cls].sym), `${CLASSES[row.cls].label}${st.game.myColor ? who : ''}`);
    text.textContent = row.comment;
    if (row.type) extra.append(h('span.chip', {}, ERROR_TYPES[row.type]));
  } else {
    tag.hidden = true;
    const num = Math.floor((i - 1) / 2) + 1;
    text.textContent = `${num}${mv.color === 'w' ? '.' : '…'} ${mv.san}`;
  }
  // подсветка хода в списке
  for (const el of document.querySelectorAll('#review-moves .mv')) el.classList.toggle('last', +el.dataset.i === i - 1);
  const cur = document.querySelector(`#review-moves .mv[data-i="${i - 1}"]`);
  // прокручиваем только сам список ходов: scrollIntoView двигал бы всю страницу вниз к списку
  if (cur) {
    const list = byId('review-moves'); // position: relative — offsetTop считается от начала списка
    const top = cur.offsetTop;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (top + cur.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + cur.offsetHeight - list.clientHeight;
  }
  drawGraphCursor();
}

// ───────── график оценки ─────────

const GW = 600;
const GH = 90;

function drawGraph() {
  const svg = byId('review-graph');
  svg.innerHTML = '';
  svg.setAttribute('viewBox', `0 0 ${GW} ${GH}`);
  if (!isReviewed(st.game)) {
    svg.hidden = true;
    return;
  }
  svg.hidden = false;
  const raw = winSeries(st.game.review);
  // лёгкое сглаживание: у мелкого поиска оценка «пилит» от хода к ходу
  const series = raw.map((v, i) => (i === 0 ? v : (v + raw[i - 1]) / 2));
  const n = series.length - 1 || 1;
  const x = (i) => (i / n) * GW;
  const y = (w) => GH - (w / 100) * GH;
  const flip = myColor() === 'b';
  const yy = (w) => y(flip ? 100 - w : w);
  svg.append(svgEl('rect', { x: 0, y: 0, width: GW, height: GH, class: 'g-bg' }));
  const pts = series.map((w, i) => `${x(i).toFixed(1)},${yy(w).toFixed(1)}`);
  svg.append(svgEl('path', { d: `M0,${GH} L${pts.join(' L')} L${GW},${GH} Z`, class: 'g-area' }));
  svg.append(svgEl('line', { x1: 0, x2: GW, y1: GH / 2, y2: GH / 2, class: 'g-mid' }));
  svg.append(svgEl('polyline', { points: pts.join(' '), class: 'g-line' }));
  st.game.review.plies.forEach((r, i) => {
    if (!['mistake', 'blunder', 'sac'].includes(r.cls)) return;
    svg.append(svgEl('circle', { cx: x(i + 1), cy: yy(series[i + 1]), r: r.cls === 'blunder' ? 5 : 4, class: `g-dot c-${r.cls}` }));
  });
  const cursor = svgEl('line', { y1: 0, y2: GH, class: 'g-cursor', id: 'g-cursor' });
  svg.append(cursor);
  drawGraphCursor();
}

function drawGraphCursor() {
  const c = byId('g-cursor');
  if (!c || !st.pos) return;
  const n = st.pos.plies.length || 1;
  const xx = (st.ply / n) * GW;
  c.setAttribute('x1', xx);
  c.setAttribute('x2', xx);
}

// ───────── сводка, моменты, список ходов ─────────

function renderSummary() {
  const box = byId('review-summary');
  box.innerHTML = '';
  if (!isReviewed(st.game)) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const me = st.game.myColor;
  const sides = me ? [me, me === 'w' ? 'b' : 'w'] : ['w', 'b'];
  for (const s of sides) {
    const d = st.game.review.sides[s];
    const name = me ? (s === me ? 'Вы' : 'Соперник') : s === 'w' ? 'Белые' : 'Чёрные';
    const acc = d.accuracy == null ? '—' : `${Math.round(d.accuracy)}%`;
    box.append(h('div.side-sum', {},
      h('span.side-name', {}, name),
      h('b.side-acc', {}, acc),
      h('span.side-counts', {},
        ...['blunder', 'mistake', 'inaccuracy'].map((k) => h(`span.cnt.c-${k}`, { title: CLASSES[k].label }, h('i', {}, CLASSES[k].sym), String(d.counts[k]))))));
  }
}

function renderMoments() {
  const box = byId('review-moments');
  box.innerHTML = '';
  if (!isReviewed(st.game) || !st.game.review.keyMoments.length) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.append(h('b.moments-title', {}, 'Ключевые моменты'));
  const wrap = h('div.moments-list');
  for (const i of st.game.review.keyMoments) {
    const r = st.game.review.plies[i];
    const num = Math.floor(i / 2) + 1;
    const mine = st.game.myColor ? r.color === st.game.myColor : true;
    const label = `${num}${r.color === 'w' ? '.' : '…'} ${r.ru}${CLASSES[r.cls].sym === '✦' ? '' : CLASSES[r.cls].sym}`;
    wrap.append(h(`button.moment.c-${r.cls}${mine ? '' : '.theirs'}`, { type: 'button', onclick: () => go(i + 1) },
      h('i', {}, CLASSES[r.cls].sym), label, h('small', {}, mine ? (st.game.myColor ? 'вы' : '') : 'соперник')));
  }
  box.append(wrap);
}

function renderMoves() {
  const ol = byId('review-moves');
  ol.innerHTML = '';
  const r = rows();
  const plies = st.pos.plies;
  const firstBlack = plies.length && plies[0].color === 'b';
  let no = +st.pos.startFen.split(' ')[5] || 1;
  let i = 0;
  while (i < plies.length) {
    const li = h('li', {}, h('span.no', {}, `${no}.`));
    const pair = [];
    if (i === 0 && firstBlack) pair.push(-1);
    while (pair.length < 2 && i < plies.length) pair.push(i++);
    for (const k of pair) {
      if (k < 0) {
        li.append(h('span.mv'));
        continue;
      }
      const row = r ? r[k] : null;
      const s = h('span.mv', { 'data-i': k, role: 'button', tabindex: 0, onclick: () => go(k + 1) }, row ? row.ru : plies[k].san);
      if (row && row.cls) s.append(h(`span.sym.c-${row.cls}`, { title: CLASSES[row.cls].label }, CLASSES[row.cls].sym));
      li.append(s);
    }
    if (pair.length < 2) li.append(h('span.mv'));
    ol.append(li);
    no++;
  }
}

function renderProgress() {
  const box = byId('review-progress');
  const waiting = st.game && !isReviewed(st.game);
  box.hidden = !waiting;
  if (!waiting) return;
  const p = reviewProgress.get(st.game.id) || 0;
  const active = reviewingId() === st.game.id;
  box.querySelector('i').style.width = `${Math.round(p * 100)}%`;
  byId('rv-progress-text').textContent = st.game.reviewError
    ? `Не получилось разобрать: ${st.game.reviewError}`
    : active ? `Тренер разбирает партию… ${Math.round(p * 100)}%` : 'Партия в очереди на разбор…';
}

function renderHead() {
  const g = st.game;
  const opp = opponentOf(g);
  byId('review-title').textContent = opp ? `Вы vs ${opp.name}` : `${g.white} — ${g.black}`;
  byId('review-sub').textContent = [RESULT[g.result], g.reason, timeClassName(g.timeClass), formatTimeControl(g.timeControl), formatDate(g.endTime)]
    .filter(Boolean).join(' · ');
  byId('rv-link').hidden = !g.url;
  if (g.url) byId('rv-link').href = g.url;
}

function renderAll() {
  renderHead();
  renderSummary();
  renderMoments();
  renderMoves();
  drawGraph();
  renderProgress();
  renderPosition();
}

export async function openReview(id) {
  const g = id ? await db.getGame(id) : null;
  if (!g) {
    location.hash = '#games';
    return;
  }
  const same = st.game && st.game.id === g.id;
  st.game = g;
  st.pos = gamePositions(g.pgn);
  st.board.setOrientation(myColor());
  if (!same) {
    // первый ключевой момент (мой) — сразу к нему; иначе с начала
    st.ply = 0;
  }
  if (!isReviewed(g) && !reviewProgress.has(g.id)) enqueueReview(g.id, { front: true });
  renderAll();
}

export function initReviewUi({ onPlayFrom }) {
  st.onPlayFrom = onPlayFrom;
  st.board = new Board(byId('review-board'), { onMove: () => {}, legalMoves: () => [] });
  st.board.setInteractive(null);
  byId('rv-first').addEventListener('click', () => go(0));
  byId('rv-prev').addEventListener('click', () => go(st.ply - 1));
  byId('rv-next').addEventListener('click', () => go(st.ply + 1));
  byId('rv-last').addEventListener('click', () => go(st.pos ? st.pos.plies.length : 0));
  byId('rv-play').addEventListener('click', () => {
    if (!st.pos) return;
    const fen = fenAt(st.ply);
    const turn = fen.split(' ')[1];
    st.onPlayFrom(fen, st.game.myColor || turn);
  });
  byId('review-graph').addEventListener('click', (e) => {
    if (!st.pos) return;
    const r = e.currentTarget.getBoundingClientRect();
    go(Math.round(((e.clientX - r.left) / r.width) * st.pos.plies.length));
  });
  // свайп по доске: влево — следующий ход, вправо — предыдущий
  let sx = null;
  const wrap = byId('review-board');
  wrap.addEventListener('pointerdown', (e) => (sx = e.clientX));
  wrap.addEventListener('pointerup', (e) => {
    if (sx == null) return;
    const dx = e.clientX - sx;
    sx = null;
    if (Math.abs(dx) > 35) go(st.ply + (dx < 0 ? 1 : -1));
    else {
      // тап по правой/левой половине доски
      const r = wrap.getBoundingClientRect();
      go(st.ply + (e.clientX > r.left + r.width / 2 ? 1 : -1));
    }
  });
  document.addEventListener('keydown', (e) => {
    if (currentScreen() !== 'review' || document.querySelector('dialog[open]')) return;
    if (e.key === 'ArrowRight') go(st.ply + 1);
    else if (e.key === 'ArrowLeft') go(st.ply - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(st.pos ? st.pos.plies.length : 0);
  });
  on('review-progress', (d) => st.game && d.id === st.game.id && currentScreen() === 'review' && renderProgress());
  on('review-queue', (d) => st.game && d.id === st.game.id && currentScreen() === 'review' && renderProgress());
  on('reviewed', async (d) => {
    if (!st.game || d.id !== st.game.id || currentScreen() !== 'review') return;
    st.game = await db.getGame(d.id);
    renderAll();
  });
  on('review-error', async (d) => {
    if (!st.game || d.id !== st.game.id) return;
    st.game = await db.getGame(d.id);
    renderProgress();
  });
}

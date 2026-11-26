// Доска: рендер, анимация фигур (diff позиций), перетаскивание и клики,
// точки ходов, подсветки, SVG-стрелки, значки оценки хода, выбор превращения.

const FILES = 'abcdefgh';
const SVG_NS = 'http://www.w3.org/2000/svg';

export class Board {
  /**
   * @param {HTMLElement} el
   * @param {{onMove: Function, legalMoves: (sq:string)=>Array<{to:string,promotion?:string}>}} opts
   */
  constructor(el, { onMove, legalMoves }) {
    this.el = el;
    this.onMove = onMove;
    this.legalMoves = legalMoves;
    this.orientation = 'w';
    this.interactive = null;
    this.position = new Map(); // square → {type,color}
    this.pieces = []; // {el, sq, type, color}
    this.selected = null;
    this.dests = [];
    this.marks = new Map(); // class → Set<square>
    this.lastMove = null;
    this.checkSq = null;
    this.drag = null;
    this._build();
  }

  _build() {
    this.el.classList.add('board');
    this.el.innerHTML = '';
    this.sqLayer = div('sq-layer');
    this.squares = new Map();
    for (let i = 0; i < 64; i++) {
      const s = div('sq');
      this.sqLayer.appendChild(s);
    }
    this.pcLayer = div('pc-layer');
    this.arrows = document.createElementNS(SVG_NS, 'svg');
    this.arrows.setAttribute('class', 'arrows');
    this.arrows.setAttribute('viewBox', '0 0 800 800');
    this.arrows.setAttribute('aria-hidden', 'true');
    this.badgeLayer = div('badge-layer');
    this.promo = div('promo');
    this.promo.hidden = true;
    this.el.append(this.sqLayer, this.pcLayer, this.arrows, this.badgeLayer, this.promo);
    this._layoutSquares();

    this.el.addEventListener('pointerdown', (e) => this._down(e));
    window.addEventListener('pointermove', (e) => this._moveDrag(e));
    window.addEventListener('pointerup', (e) => this._up(e));
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  _layoutSquares() {
    const cells = this.sqLayer.children;
    this.squares.clear();
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const sq = this.squareAt(col, row);
        const cell = cells[row * 8 + col];
        const f = FILES.indexOf(sq[0]);
        const r = +sq[1];
        cell.className = 'sq ' + ((f + r) % 2 === 1 ? 'light' : 'dark');
        cell.dataset.sq = sq;
        cell.innerHTML = '';
        if (col === 0) cell.appendChild(span('coord rank', sq[1]));
        if (row === 7) cell.appendChild(span('coord file', sq[0]));
        this.squares.set(sq, cell);
      }
    }
    this._paintSquares();
  }

  /** Экранная колонка/строка → поле. */
  squareAt(col, row) {
    return this.orientation === 'w' ? FILES[col] + (8 - row) : FILES[7 - col] + (row + 1);
  }

  coords(sq) {
    const f = FILES.indexOf(sq[0]);
    const r = +sq[1];
    return this.orientation === 'w' ? { col: f, row: 8 - r } : { col: 7 - f, row: r - 1 };
  }

  setOrientation(color) {
    if (color === this.orientation) return;
    this.orientation = color;
    this._layoutSquares();
    for (const p of this.pieces) this._place(p, false);
    this.redrawOverlays();
  }

  setInteractive(color) {
    this.interactive = color;
    this.el.classList.toggle('locked', !color);
    if (!color) this._clearSelection();
  }

  /** @param {Array<Array<{square,type,color}|null>>} board — chess.board() */
  setPosition(board, { lastMove = null, check = null, animate = true } = {}) {
    const next = new Map();
    for (const row of board) for (const p of row) if (p) next.set(p.square, { type: p.type, color: p.color });

    const used = new Set();
    const pending = [];
    // 1) фигуры, оставшиеся на месте
    for (const [sq, np] of next) {
      const keep = this.pieces.find((p) => !used.has(p) && p.sq === sq && p.type === np.type && p.color === np.color);
      if (keep) used.add(keep);
      else pending.push([sq, np]);
    }
    // 2) переехавшие фигуры: ближайшая свободная того же типа и цвета
    const created = [];
    for (const [sq, np] of pending) {
      const c = this.coords(sq);
      let best = null;
      let bestD = Infinity;
      for (const p of this.pieces) {
        if (used.has(p) || p.type !== np.type || p.color !== np.color) continue;
        const pc = this.coords(p.sq);
        const d = Math.abs(pc.col - c.col) + Math.abs(pc.row - c.row);
        if (d < bestD) {
          bestD = d;
          best = p;
        }
      }
      if (best) {
        used.add(best);
        best.sq = sq;
        this._place(best, animate);
      } else {
        created.push([sq, np]);
      }
    }
    // 3) убранные фигуры исчезают
    for (const p of this.pieces) {
      if (used.has(p)) continue;
      p.el.classList.add('gone');
      setTimeout(() => p.el.remove(), 220);
    }
    this.pieces = this.pieces.filter((p) => used.has(p));
    // 4) новые фигуры
    for (const [sq, np] of created) {
      const el = div(`pc ${np.color}${np.type}`);
      const p = { el, sq, type: np.type, color: np.color };
      this._place(p, false);
      if (animate) el.classList.add('appear');
      this.pcLayer.appendChild(el);
      this.pieces.push(p);
    }
    this.position = next;
    this.lastMove = lastMove;
    this.checkSq = check;
    this._clearSelection();
    this._paintSquares();
  }

  _place(p, animate) {
    const { col, row } = this.coords(p.sq);
    p.el.classList.toggle('instant', !animate);
    p.el.style.transform = `translate(${col * 100}%, ${row * 100}%)`;
    p.el.dataset.sq = p.sq;
  }

  pieceAt(sq) {
    return this.pieces.find((p) => p.sq === sq);
  }

  // ───────────── подсветки ─────────────

  setMarks(kind, squares) {
    if (!squares || !squares.length) this.marks.delete(kind);
    else this.marks.set(kind, new Set(squares));
    this._paintSquares();
  }

  clearMarks() {
    this.marks.clear();
    this._paintSquares();
  }

  _paintSquares() {
    for (const [sq, cell] of this.squares) {
      const base = cell.className.split(' ').filter((c) => c === 'sq' || c === 'light' || c === 'dark');
      if (this.lastMove && (sq === this.lastMove.from || sq === this.lastMove.to)) base.push('last');
      if (this.checkSq === sq) base.push('check');
      if (this.selected === sq) base.push('sel');
      const d = this.dests.find((m) => m.to === sq);
      if (d) base.push(this.position.has(sq) || d.ep ? 'dest cap' : 'dest');
      for (const [kind, set] of this.marks) if (set.has(sq)) base.push(kind);
      cell.className = base.join(' ');
    }
  }

  // ───────────── стрелки и значки ─────────────

  /** @param {Array<{from,to,kind:'best'|'alt'|'alt2'|'threat'|'hint'}>} list */
  setArrows(list) {
    this.arrowList = list || [];
    this._drawArrows();
  }

  _drawArrows() {
    const svg = this.arrows;
    svg.innerHTML = '';
    for (const a of this.arrowList || []) svg.appendChild(this._arrow(a));
  }

  _arrow({ from, to, kind = 'best' }) {
    const W = { best: 20, hint: 20, alt: 14, alt2: 11, threat: 15 }[kind] || 14;
    const a = this.coords(from);
    const b = this.coords(to);
    const p1 = { x: a.col * 100 + 50, y: a.row * 100 + 50 };
    const p2 = { x: b.col * 100 + 50, y: b.row * 100 + 50 };
    const pts = [p1];
    const dc = Math.abs(a.col - b.col);
    const dr = Math.abs(a.row - b.row);
    if ((dc === 1 && dr === 2) || (dc === 2 && dr === 1)) {
      // ход коня — Г-образная стрелка
      pts.push(dr === 2 ? { x: p1.x, y: p2.y } : { x: p2.x, y: p1.y });
    }
    pts.push(p2);
    const last = pts[pts.length - 2];
    const dx = p2.x - last.x;
    const dy = p2.y - last.y;
    const len = Math.hypot(dx, dy);
    const ux = dx / len;
    const uy = dy / len;
    const headL = W * 2.1;
    const headW = W * 2.4;
    const tip = { x: p2.x - ux * 14, y: p2.y - uy * 14 };
    const base = { x: tip.x - ux * headL, y: tip.y - uy * headL };
    const shaft = [...pts.slice(0, -1), base];
    const start = shaft[0];
    const second = shaft[1];
    const sl = Math.hypot(second.x - start.x, second.y - start.y);
    shaft[0] = { x: start.x + ((second.x - start.x) / sl) * 22, y: start.y + ((second.y - start.y) / sl) * 22 };

    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('class', `arrow ${kind}`);
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', 'M' + shaft.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' L'));
    path.setAttribute('stroke-width', W);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke-linejoin', 'round');
    path.setAttribute('stroke-linecap', 'butt');
    const head = document.createElementNS(SVG_NS, 'polygon');
    const px = -uy;
    const py = ux;
    head.setAttribute(
      'points',
      [
        [tip.x, tip.y],
        [base.x + (px * headW) / 2, base.y + (py * headW) / 2],
        [base.x - (px * headW) / 2, base.y - (py * headW) / 2],
      ]
        .map((p) => p.map((v) => v.toFixed(1)).join(','))
        .join(' '),
    );
    g.append(path, head);
    return g;
  }

  setBadge(sq, cls, sym) {
    this.badgeLayer.innerHTML = '';
    this.badge = sq ? { sq, cls, sym } : null;
    if (!sq) return;
    const { col, row } = this.coords(sq);
    const b = div(`badge c-${cls}`);
    b.textContent = sym;
    b.style.left = `${(col + 1) * 12.5}%`;
    b.style.top = `${row * 12.5}%`;
    this.badgeLayer.appendChild(b);
  }

  redrawOverlays() {
    this._drawArrows();
    if (this.badge) this.setBadge(this.badge.sq, this.badge.cls, this.badge.sym);
    this._paintSquares();
  }

  // ───────────── ввод ─────────────

  _sqFromEvent(e) {
    const r = this.el.getBoundingClientRect();
    const col = Math.floor(((e.clientX - r.left) / r.width) * 8);
    const row = Math.floor(((e.clientY - r.top) / r.height) * 8);
    if (col < 0 || col > 7 || row < 0 || row > 7) return null;
    return this.squareAt(col, row);
  }

  _select(sq) {
    this.selected = sq;
    this.dests = this.legalMoves(sq);
    this._paintSquares();
  }

  _clearSelection() {
    this.selected = null;
    this.dests = [];
    this._paintSquares();
  }

  _down(e) {
    if (e.button !== 0 || !this.promo.hidden) return;
    const sq = this._sqFromEvent(e);
    if (!sq || !this.interactive) return;
    const p = this.position.get(sq);
    // клик по полю назначения выбранной фигуры
    if (this.selected && this.dests.some((m) => m.to === sq)) {
      e.preventDefault();
      this._tryMove(this.selected, sq);
      return;
    }
    if (p && p.color === this.interactive) {
      e.preventDefault();
      const wasSelected = this.selected === sq;
      this._select(sq);
      const piece = this.pieceAt(sq);
      if (piece) {
        this.drag = { piece, from: sq, x: e.clientX, y: e.clientY, active: false, wasSelected };
        this.el.setPointerCapture?.(e.pointerId);
      }
      return;
    }
    this._clearSelection();
  }

  _moveDrag(e) {
    const d = this.drag;
    if (!d) return;
    if (!d.active && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4) return;
    d.active = true;
    const r = this.el.getBoundingClientRect();
    const size = r.width / 8;
    const x = ((e.clientX - r.left - size / 2) / size) * 100;
    const y = ((e.clientY - r.top - size / 2) / size) * 100;
    d.piece.el.classList.add('dragging', 'instant');
    d.piece.el.style.transform = `translate(${x}%, ${y}%) scale(1.08)`;
    const over = this._sqFromEvent(e);
    for (const [sq, cell] of this.squares) cell.classList.toggle('over', sq === over && this.dests.some((m) => m.to === sq));
  }

  _up(e) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    for (const cell of this.squares.values()) cell.classList.remove('over');
    d.piece.el.classList.remove('dragging');
    if (!d.active) {
      // обычный клик: повторный клик по выбранной фигуре снимает выбор
      if (d.wasSelected) this._clearSelection();
      return;
    }
    const to = this._sqFromEvent(e);
    if (to && to !== d.from && this.dests.some((m) => m.to === to)) {
      this._tryMove(d.from, to, true);
    } else {
      this._place(d.piece, true);
      d.piece.el.classList.remove('instant');
    }
  }

  async _tryMove(from, to, dropped = false) {
    const options = this.dests.filter((m) => m.to === to);
    let promotion;
    if (options.some((m) => m.promotion)) {
      const piece = this.pieceAt(from);
      if (dropped && piece) {
        const { col, row } = this.coords(to);
        piece.el.classList.add('instant');
        piece.el.style.transform = `translate(${col * 100}%, ${row * 100}%)`;
      }
      promotion = await this._askPromotion(to, this.position.get(from).color);
      if (!promotion) {
        if (piece) this._place(piece, true);
        this._clearSelection();
        return;
      }
    }
    if (dropped) {
      const piece = this.pieceAt(from);
      if (piece) piece.el.classList.add('instant');
    }
    this._clearSelection();
    this.onMove({ from, to, promotion });
  }

  _askPromotion(sq, color) {
    return new Promise((resolve) => {
      const { col, row } = this.coords(sq);
      const down = row === 0;
      this.promo.innerHTML = '';
      this.promo.hidden = false;
      const close = (val) => {
        this.promo.hidden = true;
        this.promo.innerHTML = '';
        resolve(val);
      };
      const backdrop = div('promo-backdrop');
      backdrop.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        close(null);
      });
      this.promo.appendChild(backdrop);
      ['q', 'n', 'r', 'b'].forEach((t, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `promo-btn pc ${color}${t}`;
        b.setAttribute('aria-label', { q: 'Ферзь', n: 'Конь', r: 'Ладья', b: 'Слон' }[t]);
        b.style.left = `${col * 12.5}%`;
        b.style.top = `${(down ? row + i : row - i) * 12.5}%`;
        b.addEventListener('pointerdown', (e) => {
          e.stopPropagation();
          close(t);
        });
        this.promo.appendChild(b);
      });
    });
  }
}

function div(cls) {
  const d = document.createElement('div');
  d.className = cls;
  return d;
}
function span(cls, text) {
  const s = document.createElement('span');
  s.className = cls;
  s.textContent = text;
  return s;
}

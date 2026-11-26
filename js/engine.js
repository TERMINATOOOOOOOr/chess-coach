// Обёртка над Stockfish (UCI) в Web Worker.
// Запросы выполняются строго по очереди; cancel() снимает ожидающие и останавливает текущий.

export function parseInfo(line) {
  if (!line.startsWith('info ') || line.indexOf(' pv ') === -1) return null;
  const score = / score (cp|mate) (-?\d+)/.exec(line);
  if (!score) return null;
  if (/ (lowerbound|upperbound)/.test(line)) return null;
  const depth = +(/ depth (\d+)/.exec(line) || [0, 0])[1];
  const multipv = +(/ multipv (\d+)/.exec(line) || [0, 1])[1];
  const pv = line.slice(line.indexOf(' pv ') + 4).trim().split(/\s+/);
  return {
    depth,
    multipv,
    cp: score[1] === 'cp' ? +score[2] : null,
    mate: score[1] === 'mate' ? +score[2] : null,
    pv,
    move: pv[0],
  };
}

export class Engine {
  /**
   * @param {() => Worker} makeWorker
   * @param {Record<string, string|number>} options UCI-опции, выставляются сразу после рукопожатия
   */
  constructor(makeWorker, options = {}) {
    this.options = options;
    this.worker = makeWorker();
    this.listeners = new Set();
    this.queue = [];
    this.current = null;
    this.worker.onmessage = (e) => {
      const line = typeof e.data === 'string' ? e.data : String(e.data);
      for (const fn of [...this.listeners]) fn(line);
    };
    this.ready = this._handshake();
  }

  send(cmd) {
    this.worker.postMessage(cmd);
  }

  _waitFor(prefix) {
    return new Promise((resolve) => {
      const fn = (line) => {
        if (line.startsWith(prefix)) {
          this.listeners.delete(fn);
          resolve(line);
        }
      };
      this.listeners.add(fn);
    });
  }

  async _handshake() {
    const ok = this._waitFor('uciok');
    this.send('uci');
    await ok;
    for (const [name, value] of Object.entries(this.options)) this.send(`setoption name ${name} value ${value}`);
    await this.sync();
  }

  async sync() {
    const r = this._waitFor('readyok');
    this.send('isready');
    await r;
  }

  async setOption(name, value) {
    await this.ready;
    this.send(`setoption name ${name} value ${value}`);
    await this.sync();
  }

  /**
   * Анализ позиции. Оценки — с точки зрения стороны, чей ход.
   * С moves позиция задаётся как «стартовый FEN + ходы»: так движок знает историю партии
   * и видит повторения (иначе в выигранной позиции он может сыграть вничью троекратным повтором).
   * @returns {Promise<{fen:string, lines:Array, bestmove:string|null, cancelled:boolean}>}
   */
  analyse(fen, { depth = 12, multipv = 1, movetime = 0, moves = [] } = {}) {
    return new Promise((resolve) => {
      this.queue.push({ fen, moves, depth, multipv, movetime, resolve });
      this._pump();
    });
  }

  async _pump() {
    if (this.current || !this.queue.length) return;
    const job = this.queue.shift();
    this.current = job;
    await this.ready;
    if (job.cancelled) {
      this.current = null;
      job.resolve({ fen: job.fen, lines: [], bestmove: null, cancelled: true });
      this._pump();
      return;
    }
    this.send(`setoption name MultiPV value ${job.multipv}`);
    await this.sync();
    if (job.cancelled) {
      this.current = null;
      job.resolve({ fen: job.fen, lines: [], bestmove: null, cancelled: true });
      this._pump();
      return;
    }
    const lines = new Map();
    const result = await new Promise((resolve) => {
      const fn = (line) => {
        const info = parseInfo(line);
        if (info) {
          const prev = lines.get(info.multipv);
          if (!prev || info.depth >= prev.depth) lines.set(info.multipv, info);
          return;
        }
        if (line.startsWith('bestmove')) {
          this.listeners.delete(fn);
          const bm = line.split(/\s+/)[1];
          resolve({
            fen: job.fen,
            lines: [...lines.values()].sort((a, b) => a.multipv - b.multipv),
            bestmove: bm && bm !== '(none)' ? bm : null,
            cancelled: !!job.cancelled,
          });
        }
      };
      this.listeners.add(fn);
      this.send(`position fen ${job.fen}${job.moves.length ? ` moves ${job.moves.join(' ')}` : ''}`);
      let go = `go depth ${job.depth}`;
      if (job.movetime) go += ` movetime ${job.movetime}`;
      this.send(go);
    });
    this.current = null;
    job.resolve(result);
    this._pump();
  }

  /** Снять очередь и остановить текущий поиск. */
  cancel() {
    for (const job of this.queue) job.cancelled = true;
    if (this.current) {
      this.current.cancelled = true;
      this.send('stop');
    }
  }

  newGame() {
    this.cancel();
    this.send('ucinewgame');
  }
}

/** Фабрика воркера: из встроенного исходника (однофайловая сборка) или из файла. */
export function stockfishWorkerFactory() {
  const inline = typeof document !== 'undefined' && document.getElementById('stockfish-src');
  if (inline) {
    const url = URL.createObjectURL(new Blob([inline.textContent], { type: 'text/javascript' }));
    return () => new Worker(url);
  }
  return () => new Worker('vendor/stockfish.js');
}

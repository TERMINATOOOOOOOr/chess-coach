// Фоновая очередь разбора партий: отдельный воркер Stockfish, по одной партии за раз.
import { Engine, stockfishWorkerFactory } from './engine.js';
import { analyzeGame, REVIEW_VERSION } from './review.js';
import { db } from './store.js';
import { prefs } from './prefs.js';
import { emit } from './ui/dom.js';

const queue = [];
let current = null;
let engine = null;
let busyCheck = () => false;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Прогресс разбора по id партии (0..1); есть ключ — партия в очереди или в работе. */
export const reviewProgress = new Map();

/** Пока функция возвращает true (идёт партия с ботом), разбор стоит на паузе. */
export function setBusyCheck(fn) {
  busyCheck = fn;
}

export const isReviewed = (g) => !!(g && g.review && g.review.version === REVIEW_VERSION);
export const reviewingId = () => (current ? current.id : null);

/** Поставить партию в очередь; front — разобрать прямо сейчас (текущая подождёт). */
export function enqueueReview(id, { front = false } = {}) {
  if (current && current.id === id) return;
  const at = queue.indexOf(id);
  if (at !== -1) queue.splice(at, 1);
  if (front) {
    queue.unshift(id);
    if (current) {
      // прерываем текущую партию и ставим её сразу следом
      queue.splice(1, 0, current.id);
      current.cancelled = true;
      if (engine) engine.cancel();
    }
  } else {
    queue.push(id);
  }
  if (!reviewProgress.has(id)) reviewProgress.set(id, 0);
  emit('review-queue', { id });
  pump();
}

async function pump() {
  if (current || !queue.length) return;
  const id = queue.shift();
  const job = { id, cancelled: false };
  current = job;
  const g = await db.getGame(id);
  if (!g || isReviewed(g)) {
    reviewProgress.delete(id);
    current = null;
    pump();
    return;
  }
  if (!engine) engine = new Engine(stockfishWorkerFactory(), { Contempt: 0, 'Analysis Contempt': 'Off' });
  reviewProgress.set(id, 0);
  let review = null;
  try {
    review = await analyzeGame(g, engine, {
      mode: prefs.mode,
      onProgress: (p) => {
        reviewProgress.set(id, p);
        emit('review-progress', { id, p });
      },
      waitIfBusy: async () => {
        while (busyCheck() && !job.cancelled) await wait(400);
      },
      isCancelled: () => job.cancelled,
    });
  } catch (e) {
    g.reviewError = e.message || String(e);
    await db.putGame(g);
    emit('review-error', { id, error: g.reviewError });
  }
  current = null;
  if (review) {
    g.review = review;
    delete g.reviewError;
    await db.putGame(g);
    reviewProgress.delete(id);
    emit('reviewed', { id });
  } else if (!job.cancelled) {
    reviewProgress.delete(id);
  }
  pump();
}

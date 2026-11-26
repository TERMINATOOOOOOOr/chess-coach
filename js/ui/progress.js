// Экран «Прогресс»: что получается и над чем работать, по разобранным партиям.
import { progressStats, ERROR_TYPES, PHASES } from '../review.js';
import { db } from '../store.js';
import { byId, h, svgEl } from './dom.js';
import { navigate } from './tabs.js';

const TIPS = {
  allowed_mate: 'Перед каждым ходом проверь шахи и взятия соперника — особенно рядом со своим королём.',
  missed_mate: 'Когда король соперника раскрыт, сначала перебери форсированные ходы: шахи, взятия, угрозы.',
  hung_piece: 'Главный вопрос перед ходом: «Что соперник сможет взять после моего хода?» Проверь каждую фигуру.',
  missed_tactic: 'Ищи незащищённые фигуры соперника и двойные удары. Помогают 10–15 тактических задач в день.',
  positional: 'Не спеши с атакой: улучши самую плохую фигуру и сначала доведи развитие.',
};

function sparkline(values) {
  const W = 320;
  const H = 70;
  if (values.length < 2) return h('p.spark-note', {}, 'График точности появится, когда разобранных партий станет две и больше.');
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'spark', role: 'img', 'aria-label': 'Точность по партиям', height: H });
  const x = (i) => (i / (values.length - 1)) * (W - 12) + 6;
  const y = (v) => H - 6 - (v / 100) * (H - 12);
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  svg.append(svgEl('path', { d: `M${x(0)},${H} L${pts.join(' L')} L${x(values.length - 1)},${H} Z`, class: 'spark-area' }));
  svg.append(svgEl('polyline', { points: pts.join(' '), class: 'spark-line' }));
  values.forEach((v, i) => svg.append(svgEl('circle', { cx: x(i), cy: y(v), r: i === values.length - 1 ? 4.5 : 2.5, class: 'spark-dot' })));
  return svg;
}

const fmt = (v, d = 1) => (v == null ? '—' : v.toFixed(d).replace('.', ','));

export async function renderProgress() {
  const body = byId('progress-body');
  body.innerHTML = '';
  const games = await db.allGames();
  const s = progressStats(games);
  if (!s.games) {
    body.append(h('div.card.empty-card', {},
      h('b', {}, 'Пока нечего считать'),
      h('p', {}, 'Здесь появится статистика, когда тренер разберёт хотя бы одну твою партию с chess.com.'),
      h('button.btn.primary', { type: 'button', onclick: () => navigate('games') }, 'К партиям')));
    return;
  }
  const last = s.perGame.slice(-10);
  const lastAcc = last.map((g) => g.accuracy ?? 0);
  const avgLast = lastAcc.reduce((a, b) => a + b, 0) / lastAcc.length;
  const prev = s.perGame.slice(-20, -10).map((g) => g.accuracy ?? 0);
  const trend = prev.length ? avgLast - prev.reduce((a, b) => a + b, 0) / prev.length : null;
  const wins = s.perGame.filter((g) => g.result === 'win').length;

  body.append(h('section.card.hero', {},
    h('div.hero-num', {},
      h('small', {}, `Средняя точность · ${last.length} ${last.length === 1 ? 'партия' : last.length < 5 ? 'партии' : 'партий'}`),
      h('b', {}, `${Math.round(avgLast)}%`),
      trend == null ? null : h(`span.trend${trend >= 0 ? '.up' : '.down'}`, {}, `${trend >= 0 ? '▲' : '▼'} ${fmt(Math.abs(trend))} к прошлым`)),
    sparkline(lastAcc)));

  body.append(h('div.tiles', {},
    h('div.tile', {}, h('b', {}, fmt(s.blundersPerGame)), h('small', {}, 'зевков за партию')),
    h('div.tile', {}, h('b', {}, fmt(s.mistakesPerGame)), h('small', {}, 'ошибок за партию')),
    h('div.tile', {}, h('b', {}, `${Math.round((wins / s.games) * 100)}%`), h('small', {}, `побед из ${s.games}`))));

  // фазы
  const phases = Object.entries(s.phases).filter(([, v]) => v.moves > 0);
  const weakest = phases.filter(([, v]) => v.moves >= 8).sort((a, b) => a[1].accuracy - b[1].accuracy)[0];
  const ph = h('section.card', {}, h('b.card-title', {}, 'Где теряю больше всего'));
  for (const [k, v] of phases) {
    ph.append(h(`div.bar-row${weakest && weakest[0] === k ? '.weak' : ''}`, {},
      h('span.bar-label', {}, PHASES[k]),
      h('span.bar', {}, h('i', { style: { width: `${Math.round(v.accuracy)}%` } })),
      h('span.bar-val', {}, `${Math.round(v.accuracy)}%`),
      h('small.bar-sub', {}, v.errors ? `ошибок: ${v.errors}` : 'без ошибок')));
  }
  if (weakest) ph.append(h('p.note', {}, `Слабее всего — ${PHASES[weakest[0]].toLowerCase()}. С него и начни тренировки.`));
  body.append(ph);

  // типы ошибок
  const types = Object.entries(s.types).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const tp = h('section.card', {}, h('b.card-title', {}, 'Какие ошибки чаще'));
  if (!types.length) {
    tp.append(h('p.note', {}, 'Серьёзных ошибок в разобранных партиях нет. Так держать!'));
  } else {
    const max = types[0][1];
    for (const [k, n] of types) {
      tp.append(h('div.bar-row', {},
        h('span.bar-label', {}, ERROR_TYPES[k]),
        h('span.bar.red', {}, h('i', { style: { width: `${Math.round((n / max) * 100)}%` } })),
        h('span.bar-val', {}, String(n))));
    }
    tp.append(h('div.tip', {}, h('b', {}, 'Совет тренера'), h('p', {}, TIPS[types[0][0]])));
  }
  body.append(tp);
}

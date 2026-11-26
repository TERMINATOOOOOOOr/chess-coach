// Экраны и навигация по хешу (#play, #games, #review/<id>, #progress, #settings).
// Хеш даёт рабочую кнопку «Назад» на Android и в браузере.
import { byId } from './dom.js';

const SCREENS = ['play', 'games', 'review', 'progress', 'settings'];
const TAB_OF = { review: 'games' };
let current = null;
let hooks = {};

export const currentScreen = () => current;

export function showScreen(name, arg) {
  if (!SCREENS.includes(name)) name = 'play';
  for (const s of SCREENS) byId('screen-' + s).hidden = s !== name;
  document.body.dataset.screen = name;
  const tab = TAB_OF[name] || name;
  for (const b of document.querySelectorAll('.tabbar [data-tab]')) {
    if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  current = name;
  if (hooks.onShow) hooks.onShow(name, arg);
}

/** Перейти: меняет хеш, экран переключается в обработчике hashchange. */
export function navigate(name, arg) {
  const hash = '#' + name + (arg ? '/' + encodeURIComponent(arg) : '');
  if (location.hash === hash) route();
  else location.hash = hash;
}

function route() {
  const [name, arg] = location.hash.replace(/^#/, '').split('/');
  showScreen(name || hooks.defaultScreen(), arg ? decodeURIComponent(arg) : undefined);
}

export function initTabs({ onShow, defaultScreen }) {
  hooks = { onShow, defaultScreen };
  for (const b of document.querySelectorAll('.tabbar [data-tab]')) {
    b.addEventListener('click', () => navigate(b.dataset.tab));
  }
  window.addEventListener('hashchange', route);
  route();
}

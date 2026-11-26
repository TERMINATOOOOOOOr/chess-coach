// Точка входа: экраны, синхронизация с chess.com, «Поделиться», офлайн-режим.
import { enterPlay, isPlaying, playFromPosition } from './app.js';
import { loadPrefs, prefs } from './prefs.js';
import { setBusyCheck, enqueueReview } from './reviewer.js';
import { initTabs, navigate, currentScreen } from './ui/tabs.js';
import { initGames, renderGames, syncGames, importShared } from './ui/games.js';
import { initReviewUi, openReview } from './ui/review.js';
import { renderProgress } from './ui/progress.js';
import { initSettings } from './ui/settings.js';
import { byId, toast } from './ui/dom.js';

/** Партия пришла через «Поделиться» (PWA share target или Android-интент в APK). */
async function handleShared(text) {
  if (!text || !text.trim()) return;
  navigate('games');
  toast('Ищу партию…');
  try {
    const g = await importShared(text);
    enqueueReview(g.id, { front: true });
    navigate('review', g.id);
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function main() {
  await loadPrefs();
  setBusyCheck(() => isPlaying() && currentScreen() === 'play');
  initGames();
  initReviewUi({
    onPlayFrom: (fen, color) => {
      navigate('play');
      playFromPosition(fen, color);
    },
  });
  initSettings({
    onUsernameChange: () => {
      renderGames();
      syncGames();
    },
  });

  // APK присылает текст из интента сюда (см. MainActivity.java)
  window.__shohShare = (text) => {
    handleShared(text);
    return true;
  };

  const params = new URLSearchParams(location.search);
  const shared = ['title', 'text', 'url'].map((k) => params.get(k)).filter(Boolean).join(' ');
  if (shared) history.replaceState(null, '', location.pathname + location.hash);

  initTabs({
    defaultScreen: () => (prefs.username ? 'games' : 'play'),
    onShow: (name, arg) => {
      if (name === 'play') enterPlay();
      else if (name === 'games') renderGames();
      else if (name === 'review') openReview(arg);
      else if (name === 'progress') renderProgress();
    },
  });

  if (shared) handleShared(shared);
  else if (prefs.username && prefs.autosync) syncGames();

  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol) && !window.Capacitor) {
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloaded) return;
      // вышла новая версия: перезагружаемся, но не посреди партии с ботом
      if (isPlaying()) toast('Вышло обновление Shoh — оно включится при следующем запуске.');
      else {
        reloaded = true;
        location.reload();
      }
    });
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
  document.body.classList.add('ready');
  byId('splash')?.remove();
}

main();

/**
 * Tiny entry: the HTML boot shell paints instantly while the game (and the
 * three.js / Rapier vendor chunks) load via dynamic import.
 */
import('./game')
  .then(({ startGame }) => startGame())
  .catch((err: unknown) => {
    console.error(err);
    const sub = document.querySelector('#loading .load-sub');
    if (sub) sub.textContent = 'BOOT FAILED — SEE CONSOLE';
  });

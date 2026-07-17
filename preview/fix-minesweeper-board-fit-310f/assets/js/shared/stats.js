// Stats — a game reports its outcome to the launcher shell, which persists it to
// the console's stats store (high-score leaderboards, 2-player win/loss records).
//
// Mirrors controls.js: it's just a postMessage to the parent window. A game
// running standalone (opened directly, no launcher iframe) has no parent to
// report to, so every call is a harmless no-op — games stay playable on their own.
//
// The game only knows the *game-specific* facts (a score, who won). The launcher
// owns the context (which game, room code, player names) and stitches them in
// before writing to web-api, so games never touch identity or the network.

export const Stats = {
  /**
   * Report a final score for a leaderboard game (tetris, snake, …).
   * @param {number} score
   */
  score(score) {
    post({ type: "sc:gameover", kind: "score", score: Number(score) || 0 });
  },

  /**
   * Report the outcome of a finished 2-player game.
   * @param {{ outcome: "win"|"draw", winnerSlot?: number|null }} r
   *   winnerSlot is the 1-based seat that won (null on a draw).
   */
  result({ outcome, winnerSlot = null } = {}) {
    post({
      type: "sc:gameover",
      kind: "result",
      outcome: outcome === "draw" ? "draw" : "win",
      winnerSlot: winnerSlot == null ? null : Number(winnerSlot),
    });
  },
};

function post(msg) {
  if (window.parent === window) return; // standalone — nothing to report to
  window.parent.postMessage(msg, "*");
}

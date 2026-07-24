// Roster — the launcher shell tells each running game who's connected, as a list
// of seats: { slot, name, lead }. Same-screen multiplayer games use it to label
// turns by the player's real name ("VET's turn") instead of a bare mark or "P2".
//
// It's the read-only mirror of the launcher's player list, delivered over
// postMessage (sc:players) whenever the roster changes. A game opened standalone
// (no launcher parent) simply gets an empty roster and falls back to P1/P2.

export const Roster = {
  players: [],            // [{ slot, name, lead }], seat order
  _subs: new Set(),

  /** Name for a 1-based seat, or null if that seat is empty. */
  name(slot) {
    const p = this.players.find((x) => x.slot === slot);
    return p ? p.name : null;
  },

  /** Number of connected players. */
  get count() { return this.players.length; },

  /** Subscribe to roster changes. cb(players) => void. Returns unsubscribe. */
  onChange(cb) { this._subs.add(cb); return () => this._subs.delete(cb); },

  _set(players) {
    this.players = Array.isArray(players) ? players : [];
    for (const cb of this._subs) cb(this.players);
  },
};

// Only meaningful inside the launcher shell; standalone games never hear this.
if (window.parent !== window) {
  window.addEventListener("message", (e) => {
    const m = e.data;
    if (m && m.type === "sc:players") Roster._set(m.players);
  });
}

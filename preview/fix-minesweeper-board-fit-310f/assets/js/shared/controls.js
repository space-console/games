// Controls — a game declares the controller layout it wants; the launcher shell
// relays it to the phone, which renders the matching buttons. Games that never
// call Controls.define() keep the default d-pad (opt-in). See PLAN.md (P3).
//
// The declared button `id`s flow back as ordinary intents (the shared Input
// re-emits any string), so the game just handles them in its input.on() switch.
// `hold: true` buttons send `<id>` on press and `<id>:release` on release —
// enough for held controls like pinball flippers.

export const Controls = {
  /**
   * @param {{
   *   profile?: "dpad" | "buttons",
   *   buttons?: Array<{ id: string, label: string, hold?: boolean }>,
   * }} schema
   */
  define(schema) {
    if (window.parent === window) return; // only meaningful inside the launcher shell
    window.parent.postMessage({
      type: "sc:controls",
      profile: schema && schema.profile === "buttons" ? "buttons" : "dpad",
      buttons: schema && Array.isArray(schema.buttons) ? schema.buttons : [],
    }, "*");
  },
};

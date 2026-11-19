/**
 * The engine's state-event set, as a test fixture shared by the unit suites.
 *
 * The real binding never names these: it IMPORTS the set from the umbrella's
 * `scripts/gh/lib/watch.ts` (`loadEngineStateEvents` in `lib/index.js`). The unit suites
 * inject this fixture so they need no umbrella checkout; `test/live-watch.test.js` uses
 * the real one.
 */
export const ENGINE_STATE_EVENTS = new Set(['merged', 'closed', 'conflict', 'stall']);

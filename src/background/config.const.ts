// Timing constants for the sync engine. Mirrors the proven values from the
// sync-md plugin, adapted for polling instead of file-watching.

/**
 * Debounce window for outbound (SP -> Reminders) syncs while the window is
 * focused. Short so edits propagate quickly.
 */
export const SYNC_DEBOUNCE_MS = 500;

/**
 * Debounce window for outbound syncs while the window is NOT focused. Longer
 * to avoid churn when the user is away.
 */
export const SYNC_DEBOUNCE_MS_UNFOCUSED = 15000;

/**
 * How often to poll Apple Reminders (via `remi`) for inbound changes while the
 * window is focused. Apple Reminders has no change events, so we must poll.
 */
export const POLL_INTERVAL_MS = 30000;

/**
 * How often to poll while the window is NOT focused. Longer to conserve
 * resources when the user is away.
 */
export const POLL_INTERVAL_MS_UNFOCUSED = 120000;

/**
 * Cooldown after an inbound (Reminders -> SP) sync during which SP change hooks
 * are suppressed. This prevents oscillation: applying inbound changes fires
 * ANY_TASK_UPDATE, which would otherwise immediately trigger an outbound sync.
 *
 * MUST be greater than SYNC_DEBOUNCE_MS so the suppression outlasts the
 * outbound debounce timer.
 */
export const SP_HOOK_COOLDOWN_MS = 2000;

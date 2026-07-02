import type { PluginHooks } from '@super-productivity/plugin-api';
import { SyncConfig } from '../../shared/types';
import { MappingStore } from './mapping-store';
import { syncProjectToReminders } from './sp-to-reminders';
import { syncRemindersToProject } from './reminders-to-sp';
import { RemiPermissionError } from '../helper/remi-helper';
import { lazySetInterval } from '../helper/lazy-set-interval';
import {
  POLL_INTERVAL_MS,
  POLL_INTERVAL_MS_UNFOCUSED,
  SP_HOOK_COOLDOWN_MS,
  SYNC_DEBOUNCE_MS,
  SYNC_DEBOUNCE_MS_UNFOCUSED,
} from '../config.const';
import { SyncPassResult } from './types';
import { log } from '../../shared/logger';

/**
 * Sync orchestrator. Mirrors sync-md's oscillation-prevention design, but the
 * inbound trigger is POLLING (`remi list`) instead of a file watcher, because
 * Apple Reminders has no change events.
 *
 * Anti-oscillation invariants:
 *  - `syncInProgress` guards every pass (no overlap).
 *  - `pausePolling` stops the poll loop from firing during an outbound write.
 *  - `lastInboundTimestamp` is set EARLY (before await) at the start of an
 *    inbound pass; SP change hooks fired by our own updateTask/addTask writes
 *    are suppressed while within SP_HOOK_COOLDOWN_MS of it.
 *  - Outbound (SP->remi) is debounced (short when focused, long when not) and
 *    re-checks the cooldown + inProgress flag when the timer fires.
 */

// ---- Module state -----------------------------------------------------------
let activeConfig: SyncConfig | null = null;
let store: MappingStore | null = null;

let syncInProgress = false;
let pausePolling = false;
let stopPolling: (() => void) | null = null;

let spDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let hooksRegistered = false;
let permissionSnackShown = false;

let isWindowFocused = typeof document !== 'undefined' ? document.hasFocus() : true;
let currentPollInterval = POLL_INTERVAL_MS;

// Initialize so the cooldown is already expired at startup.
let lastInboundTimestamp = -SP_HOOK_COOLDOWN_MS;

// ---- Public API -------------------------------------------------------------

export const getMappingStore = (): MappingStore | null => store;

export const initSyncManager = (config: SyncConfig): void => {
  // Reset state for a clean (re-)start.
  activeConfig = config;
  syncInProgress = false;
  pausePolling = false;
  permissionSnackShown = false;
  lastInboundTimestamp = -SP_HOOK_COOLDOWN_MS;
  clearSpDebounce();
  stopPollingLoop();

  // (Re)load mapping store and prune links for lists no longer configured.
  store = new MappingStore();
  store.load();
  const activeLists = new Set(config.mappings.map((m) => m.reminderListName));
  store.pruneListsNotIn(activeLists);

  setupWindowFocusTracking();
  setupSpHooks();

  // Kick off an initial reconciliation, then start polling.
  performFullSync('initial')
    .catch((err) => log.err('[sync-reminders] initial sync failed', errMsg(err)))
    .finally(() => startPollingLoop());
};

export const stopSyncManager = (): void => {
  clearSpDebounce();
  stopPollingLoop();
  activeConfig = null;
  store = null;
};

/** Manual "Sync Now" from the UI. Runs a full bidirectional pass. */
export const triggerManualSync = async (): Promise<SyncPassResult> => {
  return performFullSync('manual');
};

// ---- Core sync passes -------------------------------------------------------

const aggregate = (a: SyncPassResult, b: SyncPassResult): SyncPassResult => ({
  created: a.created + b.created,
  updated: a.updated + b.updated,
  completed: a.completed + b.completed,
  deleted: a.deleted + b.deleted,
  skipped: a.skipped + b.skipped,
  errors: [...a.errors, ...b.errors],
});

/**
 * Full bidirectional reconciliation across all mappings: outbound (SP->remi)
 * first so newly-created SP tasks exist as reminders, then inbound (remi->SP).
 */
const performFullSync = async (
  reason: 'initial' | 'manual' | 'poll',
): Promise<SyncPassResult> => {
  const empty: SyncPassResult = {
    created: 0,
    updated: 0,
    completed: 0,
    deleted: 0,
    skipped: 0,
    errors: [],
  };
  if (!activeConfig || !store) return empty;
  if (syncInProgress) {
    log.debug('[sync-reminders] full sync skipped (in progress)', { reason });
    return empty;
  }

  syncInProgress = true;
  pausePolling = true;
  // Set the cooldown anchor EARLY so SP hooks from inbound writes are ignored.
  lastInboundTimestamp = Date.now();

  let total = empty;
  try {
    const tags = await buildTagLookup();

    // Outbound for every mapping.
    for (const mapping of activeConfig.mappings) {
      const out = await syncProjectToReminders(
        mapping.projectId,
        mapping.reminderListName,
        activeConfig,
        store,
        tags,
      );
      total = aggregate(total, out);
    }

    // Inbound for every mapping.
    for (const mapping of activeConfig.mappings) {
      const inb = await syncRemindersToProject(
        mapping.projectId,
        mapping.reminderListName,
        {
          config: activeConfig,
          store,
          onRecurringImported: notifyRecurringOnce,
        },
      );
      total = aggregate(total, inb);
    }

    clearPermissionSnack();
  } catch (err) {
    handleSyncError(err);
  } finally {
    // Refresh the cooldown anchor so late SP hooks are still suppressed.
    lastInboundTimestamp = Date.now();
    syncInProgress = false;
    pausePolling = false;
  }

  log.debug('[sync-reminders] full sync done', {
    reason,
    created: total.created,
    updated: total.updated,
    deleted: total.deleted,
    skipped: total.skipped,
    errors: total.errors.length,
  });
  return total;
};

/** Inbound-only pass driven by the poll loop. */
const performInboundPoll = async (): Promise<void> => {
  if (!activeConfig || !store) return;
  if (syncInProgress || pausePolling) return;

  syncInProgress = true;
  lastInboundTimestamp = Date.now();
  try {
    for (const mapping of activeConfig.mappings) {
      await syncRemindersToProject(mapping.projectId, mapping.reminderListName, {
        config: activeConfig,
        store,
        onRecurringImported: notifyRecurringOnce,
      });
    }
    clearPermissionSnack();
  } catch (err) {
    handleSyncError(err);
  } finally {
    lastInboundTimestamp = Date.now();
    syncInProgress = false;
  }
};

// ---- SP change handling (outbound) -----------------------------------------

const setupSpHooks = (): void => {
  if (hooksRegistered) return;
  // Hook names are inlined as their string values (matching PluginHooks enum)
  // so this plugin has no runtime dependency on the types-only plugin-api package.
  PluginAPI.registerHook(
    'anyTaskUpdate' as PluginHooks.ANY_TASK_UPDATE,
    () => handleSpChange(),
  );
  PluginAPI.registerHook(
    'projectListUpdate' as PluginHooks.PROJECT_LIST_UPDATE,
    () => handleSpChange(),
  );
  hooksRegistered = true;
};

const handleSpChange = (): void => {
  // Suppress hooks that are echoes of our own inbound writes.
  if (Date.now() - lastInboundTimestamp < SP_HOOK_COOLDOWN_MS) {
    return;
  }
  clearSpDebounce();
  const delay = isWindowFocused ? SYNC_DEBOUNCE_MS : SYNC_DEBOUNCE_MS_UNFOCUSED;
  spDebounceTimer = setTimeout(() => {
    spDebounceTimer = null;
    if (syncInProgress) return;
    // Re-check cooldown at fire time (the timer may predate an inbound pass).
    if (Date.now() - lastInboundTimestamp < SP_HOOK_COOLDOWN_MS) return;
    void runOutboundOnly();
  }, delay);
};

/** Outbound-only pass (SP change -> remi), used by the debounced SP hook. */
const runOutboundOnly = async (): Promise<void> => {
  if (!activeConfig || !store) return;
  if (syncInProgress) return;

  syncInProgress = true;
  pausePolling = true;
  try {
    const tags = await buildTagLookup();
    for (const mapping of activeConfig.mappings) {
      await syncProjectToReminders(
        mapping.projectId,
        mapping.reminderListName,
        activeConfig,
        store,
        tags,
      );
    }
    clearPermissionSnack();
  } catch (err) {
    handleSyncError(err);
  } finally {
    syncInProgress = false;
    pausePolling = false;
  }
};

// ---- Polling loop -----------------------------------------------------------

const startPollingLoop = (): void => {
  stopPollingLoop();
  currentPollInterval = isWindowFocused
    ? POLL_INTERVAL_MS
    : POLL_INTERVAL_MS_UNFOCUSED;
  stopPolling = lazySetInterval(async () => {
    await performInboundPoll();
  }, currentPollInterval);
};

const stopPollingLoop = (): void => {
  if (stopPolling) {
    stopPolling();
    stopPolling = null;
  }
};

// ---- Window focus -----------------------------------------------------------

const setupWindowFocusTracking = (): void => {
  if (!PluginAPI.onWindowFocusChange) return;
  PluginAPI.onWindowFocusChange((focused: boolean) => {
    const was = isWindowFocused;
    isWindowFocused = focused;
    const desired = focused ? POLL_INTERVAL_MS : POLL_INTERVAL_MS_UNFOCUSED;
    // Restart the loop only if the cadence changed.
    if (desired !== currentPollInterval) {
      startPollingLoop();
    }
    // On focus gain, run an immediate inbound poll to feel responsive.
    if (focused && !was) {
      void performInboundPoll();
    }
  });
};

// ---- Helpers ----------------------------------------------------------------

interface TagLookup {
  idToTitle: Map<string, string>;
}

const buildTagLookup = async (): Promise<TagLookup> => {
  const tags = await PluginAPI.getAllTags();
  const idToTitle = new Map<string, string>();
  for (const t of tags) idToTitle.set(t.id, t.title);
  return { idToTitle };
};

const clearSpDebounce = (): void => {
  if (spDebounceTimer) {
    clearTimeout(spDebounceTimer);
    spDebounceTimer = null;
  }
};

const errMsg = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

const handleSyncError = (err: unknown): void => {
  if (err instanceof RemiPermissionError) {
    if (!permissionSnackShown) {
      permissionSnackShown = true;
      PluginAPI.showSnack({
        msg: 'Apple Reminders Sync: access denied. Grant Reminders access in System Settings > Privacy & Security, then run "remi authorize".',
        type: 'ERROR',
      });
    }
    // Pause polling until config is re-saved (which resets the flag).
    pausePolling = true;
    return;
  }
  log.err('[sync-reminders] sync error', errMsg(err));
};

const clearPermissionSnack = (): void => {
  permissionSnackShown = false;
};

let recurringHintShown = false;
const notifyRecurringOnce = (): void => {
  if (recurringHintShown) return;
  recurringHintShown = true;
  PluginAPI.showSnack({
    msg: 'Imported a recurring reminder. Super Productivity can\u2019t create the repeat rule automatically \u2014 set it up on the task if you want it to recur here.',
    type: 'INFO',
  });
};

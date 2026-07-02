import { Reminder } from '../../shared/reminder.model';

/**
 * The persisted correlation between an SP task and an Apple reminder, plus the
 * last-synced field snapshot used for change detection and loop prevention.
 */
export interface TaskLink {
  /** SP task id. */
  taskId: string;
  /** Apple reminder id (stable, returned by `remi add`). */
  reminderId: string;
  /** Apple Reminders list name this pair lives in. */
  reminderListName: string;
  /**
   * Last title we synced. Used to locate a reminder by its OLD title when the
   * SP task is renamed (remi update matches by title, not id).
   */
  lastSyncedTitle: string;
  /**
   * Hash/fingerprint of the last-synced field set. Lets us detect whether a
   * side actually changed vs. an echo of our own write.
   */
  lastSyncedFingerprint: string;
}

/** The full persisted mapping store (one per plugin, all lists combined). */
export interface MappingStoreData {
  version: 1;
  links: TaskLink[];
}

/** Result of a single sync pass, for logging/verification (no user content). */
export interface SyncPassResult {
  created: number;
  updated: number;
  completed: number;
  deleted: number;
  skipped: number;
  errors: string[];
}

export const emptyPassResult = (): SyncPassResult => ({
  created: 0,
  updated: 0,
  completed: 0,
  deleted: 0,
  skipped: 0,
  errors: [],
});

export type { Reminder };

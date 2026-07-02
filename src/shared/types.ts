// Shared types used across background + UI (config iframe).

/**
 * A single mapping between one SP project and one Apple Reminders list.
 * Multiple mappings are supported so different projects can sync to different
 * lists simultaneously.
 */
export interface ProjectListMapping {
  /** SP project id (from getAllProjects). */
  projectId: string;
  /** Apple Reminders list name (as shown in the Reminders app). */
  reminderListName: string;
}

/**
 * Plugin configuration. Stored DEVICE-LOCAL (localStorage) because the `remi`
 * binary and Reminders permission only exist on this machine. The synced task
 * DATA still propagates to iPhone/iPad/etc. via Apple/iCloud.
 */
export interface SyncConfig {
  /** Master on/off switch. */
  isEnabled: boolean;
  /** One or more project <-> list mappings. */
  mappings: ProjectListMapping[];
  /**
   * Map a task's first SP tag to an Apple Reminders section within its list.
   * Requires Full Disk Access for `remi` section support. Off by default.
   */
  isSyncTagsAsSections: boolean;
  /**
   * Encode SP timeEstimate as a `[estimate: 2h]` marker in the reminder notes
   * (and parse it back on inbound). On by default.
   */
  isSyncEstimateInNotes: boolean;
  /**
   * Absolute path to the `remi` binary. Empty = rely on PATH lookup ('remi').
   * Useful when the Electron process PATH does not include Homebrew's bin dir.
   */
  remiBinaryPath: string;
}

export const DEFAULT_CONFIG: SyncConfig = {
  isEnabled: false,
  mappings: [],
  isSyncTagsAsSections: false,
  isSyncEstimateInNotes: true,
  remiBinaryPath: '',
};

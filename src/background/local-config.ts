import { DEFAULT_CONFIG, SyncConfig, ProjectListMapping } from '../shared/types';
import { log } from '../shared/logger';

/**
 * Device-local config storage. We intentionally use localStorage (NOT
 * persistDataSynced) because the `remi` binary and Reminders permission are
 * per-machine; syncing this config to a device without remi would cause it to
 * error on startup. The task DATA still propagates via Apple/iCloud.
 */
const STORAGE_KEY = 'sync-reminders-config';

const isValidMapping = (m: unknown): m is ProjectListMapping => {
  if (!m || typeof m !== 'object') return false;
  const cast = m as Record<string, unknown>;
  return (
    typeof cast.projectId === 'string' &&
    cast.projectId.length > 0 &&
    typeof cast.reminderListName === 'string' &&
    cast.reminderListName.length > 0
  );
};

/** Coerce arbitrary parsed JSON into a well-formed SyncConfig (never throws). */
const normalizeConfig = (raw: unknown): SyncConfig => {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_CONFIG };
  }
  const cast = raw as Record<string, unknown>;
  const mappings = Array.isArray(cast.mappings)
    ? cast.mappings.filter(isValidMapping)
    : [];

  return {
    isEnabled: typeof cast.isEnabled === 'boolean' ? cast.isEnabled : false,
    mappings,
    isSyncTagsAsSections:
      typeof cast.isSyncTagsAsSections === 'boolean'
        ? cast.isSyncTagsAsSections
        : DEFAULT_CONFIG.isSyncTagsAsSections,
    isSyncEstimateInNotes:
      typeof cast.isSyncEstimateInNotes === 'boolean'
        ? cast.isSyncEstimateInNotes
        : DEFAULT_CONFIG.isSyncEstimateInNotes,
    remiBinaryPath:
      typeof cast.remiBinaryPath === 'string'
        ? cast.remiBinaryPath
        : DEFAULT_CONFIG.remiBinaryPath,
  };
};

export const loadLocalConfig = (): SyncConfig => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_CONFIG };
    return normalizeConfig(JSON.parse(raw));
  } catch (err) {
    log.err('Failed to load sync-reminders config, using defaults', err);
    return { ...DEFAULT_CONFIG };
  }
};

export const saveLocalConfig = (config: SyncConfig): void => {
  const normalized = normalizeConfig(config);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
};

/** True when the plugin is enabled AND has at least one valid mapping. */
export const isConfigActive = (config: SyncConfig): boolean =>
  config.isEnabled && config.mappings.length > 0;

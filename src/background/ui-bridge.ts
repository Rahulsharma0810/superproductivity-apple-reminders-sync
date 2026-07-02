import { loadLocalConfig, saveLocalConfig, isConfigActive } from './local-config';
import { SyncConfig } from '../shared/types';
import {
  initSyncManager,
  stopSyncManager,
  triggerManualSync,
} from './sync/sync-manager';
import {
  remiListLists,
  remiHealthCheck,
  RemiPermissionError,
} from './helper/remi-helper';
import { log } from '../shared/logger';

/**
 * Bridge between the config iframe (src/ui/index.html) and the background sync
 * engine. Mirrors sync-md's onMessage switch. Every handler returns a plain
 * `{ success, ... }` object and never throws (errors surface as snackbars or
 * in the returned payload).
 */

interface PluginMessage {
  type: string;
  config?: SyncConfig;
}

/**
 * Resolve the remi binary path for a request. Prefer the path the user has
 * typed into the (possibly unsaved) config form so "Check connection" and
 * "Sync now" reflect edits immediately; fall back to the saved config.
 */
const resolveRemiBinaryPath = (message: PluginMessage): string => {
  const fromForm = message.config?.remiBinaryPath;
  if (typeof fromForm === 'string' && fromForm.trim()) {
    return fromForm.trim();
  }
  return loadLocalConfig().remiBinaryPath;
};

const reinitFromConfig = (config: SyncConfig): void => {
  try {
    if (isConfigActive(config)) {
      initSyncManager(config);
    } else {
      stopSyncManager();
    }
  } catch (error) {
    log.err('[sync-reminders] failed to (re)initialize sync', (error as Error).message);
    PluginAPI.showSnack({
      msg: 'Apple Reminders Sync: failed to initialize. Check the config and permissions.',
      type: 'ERROR',
    });
  }
};

export const initUiBridge = (): void => {
  if (!PluginAPI.onMessage) return;

  PluginAPI.onMessage(async (rawMessage: unknown) => {
    const message = (rawMessage ?? {}) as PluginMessage;
    switch (message.type) {
      case 'getProjects':
        try {
          const projects = await PluginAPI.getAllProjects();
          return { success: true, projects };
        } catch (error) {
          return { success: false, error: (error as Error).message };
        }

      case 'getTags':
        try {
          const tags = await PluginAPI.getAllTags();
          return { success: true, tags };
        } catch (error) {
          return { success: false, error: (error as Error).message };
        }

      case 'getConfig':
        try {
          return { success: true, config: loadLocalConfig() };
        } catch (error) {
          return { success: false, error: (error as Error).message };
        }

      case 'getLists':
        try {
          const lists = await remiListLists(resolveRemiBinaryPath(message));
          return { success: true, lists };
        } catch (error) {
          if (error instanceof RemiPermissionError) {
            return {
              success: false,
              permissionDenied: true,
              error: error.message,
            };
          }
          return { success: false, error: (error as Error).message };
        }

      case 'healthCheck':
        try {
          const health = await remiHealthCheck(resolveRemiBinaryPath(message));
          return { success: true, health };
        } catch (error) {
          return { success: false, error: (error as Error).message };
        }

      case 'saveConfig':
        try {
          if (!message.config) {
            return { success: false, error: 'No config provided' };
          }
          saveLocalConfig(message.config);
          reinitFromConfig(message.config);
          return { success: true };
        } catch (error) {
          return { success: false, error: (error as Error).message };
        }

      case 'syncNow':
        try {
          const config = loadLocalConfig();
          if (!isConfigActive(config)) {
            return { success: false, error: 'Sync is not enabled or has no mappings.' };
          }
          const result = await triggerManualSync();
          return { success: true, result };
        } catch (error) {
          return { success: false, error: (error as Error).message };
        }

      default:
        return { success: false, error: 'Unknown message type' };
    }
  });
};

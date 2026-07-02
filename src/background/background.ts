import { initUiBridge } from './ui-bridge';
import { initSyncManager, stopSyncManager } from './sync/sync-manager';
import { loadLocalConfig, isConfigActive } from './local-config';
import { log } from '../shared/logger';

// Register the UI bridge synchronously so the config iframe can talk to us as
// soon as it loads.
initUiBridge();
log.log('[sync-reminders] UI bridge initialized');

// Start syncing once the app signals readiness (and only if configured+enabled).
if (PluginAPI.onReady) {
  PluginAPI.onReady(() => {
    const config = loadLocalConfig();
    if (isConfigActive(config)) {
      log.log('[sync-reminders] starting sync', {
        mappings: config.mappings.length,
      });
      initSyncManager(config);
    } else {
      log.log('[sync-reminders] sync disabled or no mappings configured');
    }
  });
}

// This plugin runs in the renderer, so it MUST clean up its timers/pollers and
// listeners when unloaded (per plugin-api guidance).
if (PluginAPI.onUnload) {
  PluginAPI.onUnload(() => {
    log.log('[sync-reminders] unloading, stopping sync manager');
    stopSyncManager();
  });
}

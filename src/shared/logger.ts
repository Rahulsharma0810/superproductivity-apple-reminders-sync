// Simple logger helper for sync-reminders plugin.
// Uses PluginAPI.log when available (renderer), falls back to console in tests.
export const log =
  typeof PluginAPI !== 'undefined'
    ? PluginAPI.log
    : {
        critical: (...args: unknown[]) => console.error('[sync-reminders]', ...args),
        err: (...args: unknown[]) => console.error('[sync-reminders]', ...args),
        error: (...args: unknown[]) => console.error('[sync-reminders]', ...args),
        log: (...args: unknown[]) => console.log('[sync-reminders]', ...args),
        normal: (...args: unknown[]) => console.log('[sync-reminders]', ...args),
        info: (...args: unknown[]) => console.info('[sync-reminders]', ...args),
        verbose: (...args: unknown[]) => console.log('[sync-reminders]', ...args),
        debug: (...args: unknown[]) => console.debug('[sync-reminders]', ...args),
        warn: (...args: unknown[]) => console.warn('[sync-reminders]', ...args),
      };

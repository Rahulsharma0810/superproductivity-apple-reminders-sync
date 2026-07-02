// Apple Reminders Sync plugin — entry barrel.
// The actual esbuild entry point is src/background/background.ts (see
// scripts/build.js). Importing this module initializes the plugin and
// re-exports the shared types for consumers/tests.
import './background/background';

export * from './shared/types';
export * from './shared/reminder.model';

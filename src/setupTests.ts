// Jest setup: provide a mock global PluginAPI for unit tests.
// Assigned before any test module imports the plugin source (which reads
// PluginAPI at module-load time, e.g. shared/logger.ts).
import type { PluginAPI as PluginAPIType } from '@super-productivity/plugin-api';

const noop = (): void => {};

const logMock = {
  critical: jest.fn(noop),
  err: jest.fn(noop),
  error: jest.fn(noop),
  log: jest.fn(noop),
  normal: jest.fn(noop),
  info: jest.fn(noop),
  verbose: jest.fn(noop),
  debug: jest.fn(noop),
  warn: jest.fn(noop),
};

const emptyAppState = {
  tasks: {},
  projects: {},
  tags: {},
  notes: {},
  taskRepeatCfgs: {},
  simpleCounters: {},
  globalConfig: {},
};

// Default: a successful, empty remi list envelope.
const defaultNodeScriptResult = {
  success: true,
  result: {
    success: true,
    stdout: '{"success":true,"data":[]}',
    stderr: '',
    exitCode: 0,
  },
};

const mockPluginAPI = {
  getTasks: jest.fn(async () => []),
  getArchivedTasks: jest.fn(async () => []),
  getAllProjects: jest.fn(async () => []),
  getAllTags: jest.fn(async () => []),
  getAppState: jest.fn(async () => emptyAppState),
  executeNodeScript: jest.fn(async () => defaultNodeScriptResult),
  loadSyncedData: jest.fn(async () => null),
  persistDataSynced: jest.fn(async () => {}),
  onMessage: jest.fn(noop),
  onReady: jest.fn(noop),
  onUnload: jest.fn(noop),
  onWindowFocusChange: jest.fn(noop),
  registerHook: jest.fn(noop),
  updateTask: jest.fn(async () => {}),
  addTask: jest.fn(async () => 'new-task-id'),
  deleteTask: jest.fn(async () => {}),
  addTag: jest.fn(async () => 'new-tag-id'),
  updateTag: jest.fn(async () => {}),
  showSnack: jest.fn(noop),
  notify: jest.fn(async () => {}),
  isWindowFocused: jest.fn(() => true),
  log: logMock,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(global as unknown as { PluginAPI: PluginAPIType }).PluginAPI =
  mockPluginAPI as unknown as PluginAPIType;

// Re-reset localStorage between tests to avoid cross-test bleed.
beforeEach(() => {
  window.localStorage.clear();
  jest.clearAllMocks();
});

export { mockPluginAPI, logMock };

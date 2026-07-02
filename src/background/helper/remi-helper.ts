import { log } from '../../shared/logger';
import { Reminder, ReminderList, ReminderSection } from '../../shared/reminder.model';

/**
 * Error thrown when Reminders access has not been granted to the host process.
 * The sync manager catches this specifically to show an actionable snackbar
 * instead of a generic failure.
 */
export class RemiPermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemiPermissionError';
  }
}

/** A single `remi` invocation result (already-parsed payload). */
export interface RemiResult<T> {
  data: T;
}

/**
 * The Node script executed in the (real) subprocess. It receives the resolved
 * remi binary path and argv via `args`, runs remi with --json, and returns a
 * structured object. The literal string 'child_process' below is REQUIRED: it
 * routes execution to the unrestricted Node subprocess path rather than the vm
 * sandbox (which forbids child_process).
 *
 * We spawn via execFileSync (no shell) to avoid any argument-injection concern
 * with task titles/notes.
 */
const REMI_RUNNER_SCRIPT = `
  const { execFileSync } = require('child_process');
  const bin = args[0];
  const argv = args[1];
  let stdout = '';
  let stderr = '';
  let exitCode = 0;
  try {
    stdout = execFileSync(bin, argv, {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeout: 25000,
    });
  } catch (err) {
    // Non-zero exit: remi prints the JSON error envelope to stderr.
    exitCode = typeof err.status === 'number' ? err.status : 1;
    stdout = err.stdout ? String(err.stdout) : '';
    stderr = err.stderr ? String(err.stderr) : String(err.message || err);
  }
  return { success: true, stdout, stderr, exitCode };
`;

interface RunnerOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const DENIED_MARKER = 'access denied';

/**
 * Parse remi's --json envelope. remi is inconsistent:
 *  - success:  STDOUT `{ success: true, data: <T> }`
 *  - error:    STDERR `{ success: false, error: { code, message, suggestion } }`
 *  - denied:   sometimes `{ success: true, data: { success: false, error: '...' } }`
 *
 * Returns the real payload `<T>` or throws (RemiPermissionError on denial).
 */
const parseEnvelope = <T,>(out: RunnerOutput): T => {
  const raw = (out.stdout && out.stdout.trim()) || (out.stderr && out.stderr.trim()) || '';
  if (!raw) {
    throw new Error('remi produced no output');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Not JSON at all — surface a trimmed hint (no user content expected here).
    if (raw.toLowerCase().includes(DENIED_MARKER)) {
      throw new RemiPermissionError(raw);
    }
    throw new Error(`remi returned non-JSON output: ${raw.slice(0, 200)}`);
  }

  const obj = parsed as { success?: boolean; data?: unknown; error?: unknown };

  // Top-level error envelope.
  if (obj.success === false) {
    const err = obj.error as { message?: string } | string | undefined;
    const msg = typeof err === 'string' ? err : err?.message || 'Unknown remi error';
    if (msg.toLowerCase().includes(DENIED_MARKER)) {
      throw new RemiPermissionError(msg);
    }
    throw new Error(msg);
  }

  const data = obj.data;

  // Inner permission-denied payload: { data: { success: false, error: '...' } }
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const inner = data as { success?: boolean; error?: string };
    if (inner.success === false) {
      const msg = inner.error || 'remi command failed';
      if (msg.toLowerCase().includes(DENIED_MARKER)) {
        throw new RemiPermissionError(msg);
      }
      throw new Error(msg);
    }
  }

  return data as T;
};

/**
 * Run `remi` with the given argv (each element passed as a separate exec arg;
 * no shell involved). `--json` is prepended automatically. Returns the parsed
 * `data` payload.
 */
export const runRemi = async <T,>(
  argv: string[],
  remiBinaryPath: string,
): Promise<T> => {
  if (!PluginAPI?.executeNodeScript) {
    throw new Error('Node script execution is not available (desktop only).');
  }

  // Resolve the binary. Empty config => try common locations then bare 'remi'.
  const bin = remiBinaryPath && remiBinaryPath.trim() ? remiBinaryPath.trim() : 'remi';
  const fullArgv = ['--json', ...argv];

  const execResult = await PluginAPI.executeNodeScript({
    script: REMI_RUNNER_SCRIPT,
    args: [bin, fullArgv],
    timeout: 30000,
  });

  if (!execResult.success) {
    const errMsg =
      typeof execResult.error === 'string'
        ? execResult.error
        : execResult.error?.message;
    throw new Error(errMsg || 'Failed to execute remi via node script');
  }
  const runner = execResult.result as RunnerOutput | undefined;
  if (!runner) {
    throw new Error('remi runner returned no result');
  }

  // ENOENT / spawn failure surfaces in stderr with no JSON.
  if (
    runner.exitCode !== 0 &&
    !runner.stdout.trim() &&
    /ENOENT|not found|command not found|spawn/i.test(runner.stderr)
  ) {
    throw new Error(
      `Could not run "${bin}". Ensure remi is installed and the path is correct. (${runner.stderr.trim().slice(0, 160)})`,
    );
  }

  return parseEnvelope<T>(runner);
};

// ---- Typed command wrappers -------------------------------------------------

export const remiListLists = (remiBin: string): Promise<ReminderList[]> =>
  runRemi<ReminderList[]>(['lists'], remiBin);

export const remiListReminders = (
  listName: string,
  remiBin: string,
  opts: { includeCompleted?: boolean; withSection?: boolean } = {},
): Promise<Reminder[]> => {
  const argv = ['list', listName];
  if (opts.includeCompleted) argv.push('--include-completed');
  if (opts.withSection) argv.push('--section');
  return runRemi<Reminder[]>(argv, remiBin);
};

export const remiSections = (
  listName: string,
  remiBin: string,
): Promise<ReminderSection[]> => runRemi<ReminderSection[]>(['sections', listName], remiBin);

export interface RemiAddResult {
  message: string;
  id: string;
}

export interface RemiAddOptions {
  section?: string;
  due?: string;
  priority?: 'none' | 'low' | 'medium' | 'high';
  notes?: string;
  repeat?: string;
}

export const remiAdd = (
  listName: string,
  title: string,
  remiBin: string,
  opts: RemiAddOptions = {},
): Promise<RemiAddResult> => {
  const argv = ['add', listName, title];
  if (opts.section) argv.push('--section', opts.section);
  if (opts.due) argv.push('--due', opts.due);
  if (opts.priority && opts.priority !== 'none') argv.push('--priority', opts.priority);
  if (opts.notes !== undefined) argv.push('--notes', opts.notes);
  if (opts.repeat) argv.push('--repeat', opts.repeat);
  return runRemi<RemiAddResult>(argv, remiBin);
};

export interface RemiUpdateOptions {
  newTitle?: string;
  due?: string;
  clearDue?: boolean;
  priority?: 'none' | 'low' | 'medium' | 'high';
  notes?: string;
}

/** remi update matches by CURRENT title (fuzzy). Pass the last-synced title. */
export const remiUpdate = (
  listName: string,
  currentTitle: string,
  remiBin: string,
  opts: RemiUpdateOptions = {},
): Promise<{ message: string }> => {
  const argv = ['update', listName, currentTitle];
  if (opts.newTitle !== undefined) argv.push('--title', opts.newTitle);
  if (opts.clearDue) argv.push('--clear-due');
  else if (opts.due) argv.push('--due', opts.due);
  if (opts.priority) argv.push('--priority', opts.priority);
  if (opts.notes !== undefined) argv.push('--notes', opts.notes);
  return runRemi<{ message: string }>(argv, remiBin);
};

export const remiComplete = (
  listName: string,
  title: string,
  reminderId: string,
  remiBin: string,
): Promise<{ message: string }> =>
  runRemi<{ message: string }>(
    ['complete', listName, title, '--id', reminderId],
    remiBin,
  );

export const remiDelete = (
  listName: string,
  title: string,
  reminderId: string,
  remiBin: string,
): Promise<{ message: string }> =>
  runRemi<{ message: string }>(
    ['delete', listName, title, '--id', reminderId, '--confirm'],
    remiBin,
  );

export const remiCreateSection = (
  listName: string,
  section: string,
  remiBin: string,
): Promise<unknown> => runRemi(['create-section', listName, section], remiBin);

export const remiMove = (
  listName: string,
  title: string,
  section: string,
  remiBin: string,
): Promise<unknown> =>
  runRemi(['move', listName, title, '--to-section', section], remiBin);

/**
 * Probe whether remi is runnable and Reminders access is granted. Returns a
 * discriminated result so the UI can show a precise status.
 */
export const remiHealthCheck = async (
  remiBin: string,
): Promise<{ ok: boolean; permission: boolean; message: string }> => {
  try {
    const lists = await remiListLists(remiBin);
    return {
      ok: true,
      permission: true,
      message: `Connected. ${lists.length} list(s) available.`,
    };
  } catch (err) {
    if (err instanceof RemiPermissionError) {
      return {
        ok: true,
        permission: false,
        message:
          'Reminders access is denied. Grant access under System Settings > Privacy & Security > Reminders, then run "remi authorize".',
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    log.err('remi health check failed', msg);
    return { ok: false, permission: false, message: msg };
  }
};

import { mockPluginAPI } from '../../setupTests';
import {
  RemiPermissionError,
  remiAdd,
  remiHealthCheck,
  runRemi,
} from '../helper/remi-helper';

/**
 * Craft the shape executeNodeScript resolves to. The REMI_RUNNER_SCRIPT returns
 * { success, stdout, stderr, exitCode }; the executor wraps that as
 * result.result. So the outer envelope is { success, result: <runner output> }.
 */
const nodeResult = (
  runner: { stdout?: string; stderr?: string; exitCode?: number },
  outerSuccess = true,
  outerError?: string,
): unknown => ({
  success: outerSuccess,
  error: outerError,
  result: {
    stdout: runner.stdout ?? '',
    stderr: runner.stderr ?? '',
    exitCode: runner.exitCode ?? 0,
  },
});

const mockExec = mockPluginAPI.executeNodeScript as jest.Mock;

describe('runRemi / parseEnvelope', () => {
  it('returns the data payload on a success envelope (STDOUT)', async () => {
    mockExec.mockResolvedValueOnce(
      nodeResult({ stdout: '{"success":true,"data":[{"id":"1"}]}' }),
    );
    const data = await runRemi<{ id: string }[]>(['lists'], '');
    expect(data).toEqual([{ id: '1' }]);
  });

  it('prepends --json and forwards argv + resolved binary to the script', async () => {
    mockExec.mockResolvedValueOnce(
      nodeResult({ stdout: '{"success":true,"data":[]}' }),
    );
    await runRemi(['lists'], '/opt/homebrew/bin/remi');
    const call = mockExec.mock.calls[0][0];
    expect(call.args[0]).toBe('/opt/homebrew/bin/remi');
    expect(call.args[1]).toEqual(['--json', 'lists']);
  });

  it('falls back to bare "remi" when no path configured', async () => {
    mockExec.mockResolvedValueOnce(
      nodeResult({ stdout: '{"success":true,"data":[]}' }),
    );
    await runRemi(['lists'], '   ');
    expect(mockExec.mock.calls[0][0].args[0]).toBe('remi');
  });

  it('throws the message on a top-level error envelope (STDERR)', async () => {
    mockExec.mockResolvedValueOnce(
      nodeResult({
        stderr: '{"success":false,"error":{"code":"UNKNOWN","message":"boom"}}',
        exitCode: 1,
      }),
    );
    await expect(runRemi(['list', 'X'], '')).rejects.toThrow('boom');
  });

  it('throws RemiPermissionError on a top-level denied error envelope', async () => {
    mockExec.mockResolvedValueOnce(
      nodeResult({
        stderr:
          '{"success":false,"error":{"message":"Reminders access denied. Grant in System Settings."}}',
        exitCode: 1,
      }),
    );
    await expect(runRemi(['lists'], '')).rejects.toBeInstanceOf(
      RemiPermissionError,
    );
  });

  it('throws RemiPermissionError on the inner denied payload (outer success:true)', async () => {
    mockExec.mockResolvedValueOnce(
      nodeResult({
        stdout:
          '{"success":true,"data":{"success":false,"error":"Reminders access denied."}}',
      }),
    );
    await expect(runRemi(['today'], '')).rejects.toBeInstanceOf(
      RemiPermissionError,
    );
  });

  it('does not treat a normal object payload as an inner-denial', async () => {
    mockExec.mockResolvedValueOnce(
      nodeResult({
        stdout: '{"success":true,"data":{"message":"Added","id":"rem-9"}}',
      }),
    );
    const data = await runRemi<{ id: string }>(['add', 'L', 'T'], '');
    expect(data).toEqual({ message: 'Added', id: 'rem-9' });
  });

  it('throws a clear install error on ENOENT (spawn failure, no stdout)', async () => {
    mockExec.mockResolvedValueOnce(
      nodeResult({
        stderr: 'spawn remi ENOENT',
        exitCode: 127,
      }),
    );
    await expect(runRemi(['lists'], '')).rejects.toThrow(/Could not run/i);
  });

  it('throws when the node executor itself reports failure (string error)', async () => {
    mockExec.mockResolvedValueOnce({ success: false, error: 'no consent' });
    await expect(runRemi(['lists'], '')).rejects.toThrow('no consent');
  });

  it('throws when the node executor reports a structured error object', async () => {
    mockExec.mockResolvedValueOnce({
      success: false,
      error: { code: 'NO_CONSENT', message: 'user denied' },
    });
    await expect(runRemi(['lists'], '')).rejects.toThrow('user denied');
  });

  it('throws on non-JSON output that is not a denial', async () => {
    mockExec.mockResolvedValueOnce(nodeResult({ stdout: 'total garbage' }));
    await expect(runRemi(['lists'], '')).rejects.toThrow(/non-JSON/i);
  });

  it('throws RemiPermissionError on non-JSON output that mentions access denied', async () => {
    mockExec.mockResolvedValueOnce(
      nodeResult({ stdout: 'Error: reminders access denied by user' }),
    );
    await expect(runRemi(['lists'], '')).rejects.toBeInstanceOf(
      RemiPermissionError,
    );
  });
});

describe('remiAdd argv construction', () => {
  it('builds add argv with all options and returns {message,id}', async () => {
    mockExec.mockResolvedValueOnce(
      nodeResult({
        stdout: '{"success":true,"data":{"message":"Added","id":"rem-42"}}',
      }),
    );
    const res = await remiAdd('Groceries', 'Buy milk', '', {
      due: '2026-03-15',
      notes: 'Body [sp:task-1]',
      repeat: 'weekly',
      section: 'Errands',
      priority: 'high',
    });
    expect(res).toEqual({ message: 'Added', id: 'rem-42' });

    const argv: string[] = mockExec.mock.calls[0][0].args[1];
    expect(argv).toEqual([
      '--json',
      'add',
      'Groceries',
      'Buy milk',
      '--section',
      'Errands',
      '--due',
      '2026-03-15',
      '--priority',
      'high',
      '--notes',
      'Body [sp:task-1]',
      '--repeat',
      'weekly',
    ]);
  });

  it('omits --priority when none', async () => {
    mockExec.mockResolvedValueOnce(
      nodeResult({
        stdout: '{"success":true,"data":{"message":"ok","id":"x"}}',
      }),
    );
    await remiAdd('L', 'T', '', { priority: 'none' });
    const argv: string[] = mockExec.mock.calls[0][0].args[1];
    expect(argv).not.toContain('--priority');
  });
});

describe('remiHealthCheck', () => {
  it('reports connected + permission when lists resolve', async () => {
    mockExec.mockResolvedValueOnce(
      nodeResult({
        stdout: '{"success":true,"data":[{"id":"1","title":"Inbox"}]}',
      }),
    );
    const health = await remiHealthCheck('');
    expect(health.ok).toBe(true);
    expect(health.permission).toBe(true);
    expect(health.message).toMatch(/1 list/);
  });

  it('reports ok but no permission on denial', async () => {
    mockExec.mockResolvedValueOnce(
      nodeResult({
        stdout:
          '{"success":true,"data":{"success":false,"error":"Reminders access denied."}}',
      }),
    );
    const health = await remiHealthCheck('');
    expect(health.ok).toBe(true);
    expect(health.permission).toBe(false);
    expect(health.message).toMatch(/denied/i);
  });

  it('reports not-ok on a generic failure', async () => {
    mockExec.mockResolvedValueOnce(
      nodeResult({ stderr: 'spawn remi ENOENT', exitCode: 127 }),
    );
    const health = await remiHealthCheck('');
    expect(health.ok).toBe(false);
    expect(health.permission).toBe(false);
  });
});

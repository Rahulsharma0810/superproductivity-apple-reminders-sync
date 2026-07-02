import { Task } from '@super-productivity/plugin-api';
import {
  buildReminderNotes,
  epochToLocalYmd,
  extractRepeatRule,
  extractSpTaskId,
  fingerprintReminder,
  fingerprintSpTask,
  formatEstimate,
  parseEstimateMarker,
  repeatCfgToRemi,
  SimpleRepeatCfg,
  spCurrentDueYmd,
  spDueToRemiDate,
  stripAllMarkers,
} from '../sync/field-mapping';
import { Reminder } from '../../shared/reminder.model';

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_MINUTE = 60 * 1000;

/** Minimal Task factory with sensible defaults; override per test. */
const makeTask = (overrides: Partial<Task> = {}): Task =>
  ({
    id: 'task-1',
    title: 'A task',
    notes: undefined,
    timeEstimate: 0,
    timeSpent: 0,
    isDone: false,
    projectId: 'proj-1',
    tagIds: [],
    parentId: undefined,
    created: 0,
    subTaskIds: [],
    ...overrides,
  }) as Task;

const makeReminder = (overrides: Partial<Reminder> = {}): Reminder => ({
  id: 'rem-1',
  title: 'A reminder',
  isCompleted: false,
  listID: 'list-1',
  listName: 'Inbox',
  priority: 'none',
  ...overrides,
});

describe('parseEstimateMarker', () => {
  it('returns 0 when no notes / no marker', () => {
    expect(parseEstimateMarker(undefined)).toBe(0);
    expect(parseEstimateMarker('')).toBe(0);
    expect(parseEstimateMarker('just some notes')).toBe(0);
  });

  it('parses hours', () => {
    expect(parseEstimateMarker('[estimate: 2h]')).toBe(2 * MS_PER_HOUR);
  });

  it('parses minutes', () => {
    expect(parseEstimateMarker('[estimate: 30m]')).toBe(30 * MS_PER_MINUTE);
  });

  it('parses combined h+m', () => {
    expect(parseEstimateMarker('[estimate: 1h30m]')).toBe(
      MS_PER_HOUR + 30 * MS_PER_MINUTE,
    );
  });

  it('parses fractional hours', () => {
    expect(parseEstimateMarker('[estimate: 1.5h]')).toBe(1.5 * MS_PER_HOUR);
  });

  it('treats a bare number as hours', () => {
    expect(parseEstimateMarker('[estimate: 2]')).toBe(2 * MS_PER_HOUR);
  });

  it('is case-insensitive and tolerates surrounding text', () => {
    expect(parseEstimateMarker('foo [ESTIMATE: 45m] bar')).toBe(
      45 * MS_PER_MINUTE,
    );
  });
});

describe('formatEstimate', () => {
  it('formats zero/negative as 0m', () => {
    expect(formatEstimate(0)).toBe('0m');
    expect(formatEstimate(-5)).toBe('0m');
  });

  it('formats whole hours', () => {
    expect(formatEstimate(2 * MS_PER_HOUR)).toBe('2h');
  });

  it('formats minutes only', () => {
    expect(formatEstimate(30 * MS_PER_MINUTE)).toBe('30m');
  });

  it('formats hours + minutes', () => {
    expect(formatEstimate(MS_PER_HOUR + 30 * MS_PER_MINUTE)).toBe('1h30m');
  });

  it('round-trips with parseEstimateMarker for h+m values', () => {
    const ms = 2 * MS_PER_HOUR + 15 * MS_PER_MINUTE;
    const formatted = formatEstimate(ms);
    expect(parseEstimateMarker(`[estimate: ${formatted}]`)).toBe(ms);
  });
});

describe('stripAllMarkers', () => {
  it('returns empty string for undefined/empty', () => {
    expect(stripAllMarkers(undefined)).toBe('');
    expect(stripAllMarkers('')).toBe('');
  });

  it('removes all three markers and trims', () => {
    const notes = 'Real note\n\n[estimate: 2h] [repeats: weekly] [sp:abc]';
    expect(stripAllMarkers(notes)).toBe('Real note');
  });

  it('leaves ordinary notes untouched', () => {
    expect(stripAllMarkers('Buy milk')).toBe('Buy milk');
  });

  it('collapses excess blank lines left by removal', () => {
    const notes = 'Line1\n\n\n\n[sp:abc]';
    expect(stripAllMarkers(notes)).toBe('Line1');
  });
});

describe('extractSpTaskId / extractRepeatRule', () => {
  it('extracts the sp task id', () => {
    expect(extractSpTaskId('text [sp:task-123]')).toBe('task-123');
  });

  it('returns null when no sp marker', () => {
    expect(extractSpTaskId('no marker here')).toBeNull();
    expect(extractSpTaskId(undefined)).toBeNull();
  });

  it('extracts the repeat rule', () => {
    expect(extractRepeatRule('[repeats: every 2 weeks]')).toBe('every 2 weeks');
  });

  it('returns null when no repeat marker', () => {
    expect(extractRepeatRule('nope')).toBeNull();
    expect(extractRepeatRule(undefined)).toBeNull();
  });
});

describe('buildReminderNotes', () => {
  it('always appends the sp marker LAST', () => {
    const task = makeTask({ id: 'abc', notes: 'Hello', timeEstimate: 2 * MS_PER_HOUR });
    const out = buildReminderNotes(task, { syncEstimate: true });
    expect(out.endsWith('[sp:abc]')).toBe(true);
    expect(out).toContain('Hello');
    expect(out).toContain('[estimate: 2h]');
    // estimate must come before the sp marker
    expect(out.indexOf('[estimate: 2h]')).toBeLessThan(out.indexOf('[sp:abc]'));
  });

  it('omits estimate when syncEstimate is false', () => {
    const task = makeTask({ id: 'abc', timeEstimate: 2 * MS_PER_HOUR });
    const out = buildReminderNotes(task, { syncEstimate: false });
    expect(out).not.toContain('[estimate:');
    expect(out).toBe('[sp:abc]');
  });

  it('omits estimate when timeEstimate is 0', () => {
    const task = makeTask({ id: 'abc', timeEstimate: 0 });
    const out = buildReminderNotes(task, { syncEstimate: true });
    expect(out).not.toContain('[estimate:');
  });

  it('includes a preserved repeat rule', () => {
    const task = makeTask({ id: 'abc' });
    const out = buildReminderNotes(task, {
      syncEstimate: false,
      preservedRepeatRule: 'weekly',
    });
    expect(out).toContain('[repeats: weekly]');
    expect(out.endsWith('[sp:abc]')).toBe(true);
  });

  it('does not double-embed markers already present in notes (strips first)', () => {
    const task = makeTask({
      id: 'abc',
      notes: 'Body [sp:old] [estimate: 9h]',
      timeEstimate: 2 * MS_PER_HOUR,
    });
    const out = buildReminderNotes(task, { syncEstimate: true });
    // Only one sp marker, and it is the fresh id.
    expect(out.match(/\[sp:/g)?.length).toBe(1);
    expect(out).toContain('[sp:abc]');
    expect(out).not.toContain('[sp:old]');
    // Only the fresh estimate remains.
    expect(out.match(/\[estimate:/g)?.length).toBe(1);
    expect(out).toContain('[estimate: 2h]');
    expect(out).not.toContain('9h');
  });

  it('round-trips: stripAllMarkers(buildReminderNotes) === original user notes', () => {
    const task = makeTask({
      id: 'abc',
      notes: 'Multi\nline\nnote',
      timeEstimate: MS_PER_HOUR,
    });
    const built = buildReminderNotes(task, { syncEstimate: true });
    expect(stripAllMarkers(built)).toBe('Multi\nline\nnote');
  });
});

describe('spDueToRemiDate / spCurrentDueYmd / epochToLocalYmd', () => {
  it('prefers dueDay verbatim', () => {
    const task = makeTask({ dueDay: '2026-03-15' });
    expect(spDueToRemiDate(task)).toBe('2026-03-15');
    expect(spCurrentDueYmd(task)).toBe('2026-03-15');
  });

  it('downgrades dueWithTime to its local date', () => {
    // Noon local avoids any TZ date-flip regardless of runner offset.
    const noonLocal = new Date(2026, 2, 15, 12, 0, 0, 0).getTime();
    const task = makeTask({ dueWithTime: noonLocal });
    expect(spDueToRemiDate(task)).toBe('2026-03-15');
    expect(spCurrentDueYmd(task)).toBe('2026-03-15');
  });

  it('returns null when no due', () => {
    expect(spDueToRemiDate(makeTask())).toBeNull();
    expect(spCurrentDueYmd(makeTask())).toBeNull();
  });

  it('epochToLocalYmd zero-pads month/day', () => {
    const jan5 = new Date(2026, 0, 5, 12, 0, 0, 0).getTime();
    expect(epochToLocalYmd(jan5)).toBe('2026-01-05');
  });
});

describe('repeatCfgToRemi', () => {
  const cfg = (o: Partial<SimpleRepeatCfg>): SimpleRepeatCfg => ({
    repeatCycle: 'DAILY',
    repeatEvery: 1,
    ...o,
  });

  it('every 1 -> cycle word', () => {
    expect(repeatCfgToRemi(cfg({ repeatCycle: 'DAILY', repeatEvery: 1 }))).toBe(
      'daily',
    );
    expect(repeatCfgToRemi(cfg({ repeatCycle: 'WEEKLY', repeatEvery: 1 }))).toBe(
      'weekly',
    );
    expect(
      repeatCfgToRemi(cfg({ repeatCycle: 'MONTHLY', repeatEvery: 1 })),
    ).toBe('monthly');
    expect(repeatCfgToRemi(cfg({ repeatCycle: 'YEARLY', repeatEvery: 1 }))).toBe(
      'yearly',
    );
  });

  it('every N -> "every N <unit>s"', () => {
    expect(repeatCfgToRemi(cfg({ repeatCycle: 'WEEKLY', repeatEvery: 2 }))).toBe(
      'every 2 weeks',
    );
    expect(
      repeatCfgToRemi(cfg({ repeatCycle: 'MONTHLY', repeatEvery: 3 })),
    ).toBe('every 3 months');
    expect(repeatCfgToRemi(cfg({ repeatCycle: 'DAILY', repeatEvery: 5 }))).toBe(
      'every 5 days',
    );
  });

  it('WEEKLY with specific day flags appends " on <days>"', () => {
    expect(
      repeatCfgToRemi(
        cfg({
          repeatCycle: 'WEEKLY',
          repeatEvery: 1,
          monday: true,
          friday: true,
        }),
      ),
    ).toBe('weekly on monday,friday');
  });

  it('WEEKLY with ALL 7 days does NOT append days', () => {
    expect(
      repeatCfgToRemi(
        cfg({
          repeatCycle: 'WEEKLY',
          repeatEvery: 1,
          monday: true,
          tuesday: true,
          wednesday: true,
          thursday: true,
          friday: true,
          saturday: true,
          sunday: true,
        }),
      ),
    ).toBe('weekly');
  });

  it('returns null for invalid cfg', () => {
    expect(repeatCfgToRemi(cfg({ repeatEvery: 0 }))).toBeNull();
    expect(
      repeatCfgToRemi(null as unknown as SimpleRepeatCfg),
    ).toBeNull();
  });
});

describe('fingerprints', () => {
  it('fingerprintSpTask changes when a synced field changes', () => {
    const base = makeTask({ title: 'T', notes: 'N', timeEstimate: MS_PER_HOUR });
    const fp1 = fingerprintSpTask(base, 'work');
    expect(fingerprintSpTask(makeTask({ ...base, title: 'T2' }), 'work')).not.toBe(
      fp1,
    );
    expect(fingerprintSpTask(base, 'home')).not.toBe(fp1);
    // Identical inputs => identical fingerprint.
    expect(fingerprintSpTask(base, 'work')).toBe(fp1);
  });

  it('fingerprintSpTask ignores plugin markers in notes', () => {
    const a = makeTask({ notes: 'Body' });
    const b = makeTask({ notes: 'Body\n\n[sp:task-1]' });
    expect(fingerprintSpTask(a, null)).toBe(fingerprintSpTask(b, null));
  });

  it('fingerprintReminder changes when a relevant field changes', () => {
    const base = makeReminder({ title: 'R', notes: 'N' });
    const fp1 = fingerprintReminder(base);
    expect(fingerprintReminder(makeReminder({ ...base, isCompleted: true }))).not.toBe(
      fp1,
    );
    expect(fingerprintReminder(makeReminder({ ...base, dueDate: '2026-01-01' }))).not.toBe(
      fp1,
    );
    expect(fingerprintReminder(base)).toBe(fp1);
  });

  it('fingerprintReminder ignores markers but reflects the parsed estimate', () => {
    const noMarker = makeReminder({ notes: 'Body' });
    const withEstimate = makeReminder({ notes: 'Body\n\n[estimate: 2h] [sp:x]' });
    // Stripped notes are equal, but the parsed estimate differs => fp differs.
    expect(fingerprintReminder(noMarker)).not.toBe(
      fingerprintReminder(withEstimate),
    );
  });
});

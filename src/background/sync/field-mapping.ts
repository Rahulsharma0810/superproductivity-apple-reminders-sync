import { Task } from '@super-productivity/plugin-api';
import { Reminder } from '../../shared/reminder.model';

/**
 * Pure field-mapping helpers between SP tasks and Apple reminders. No side
 * effects, no PluginAPI/remi calls — this is the unit-tested core.
 *
 * ---- Hidden note markers ----------------------------------------------------
 * remi notes carry hidden markers appended by this plugin, stripped before the
 * text is shown back in SP:
 *   [sp:<taskId>]        always — stable correlator / fallback matcher
 *   [estimate: 2h]       when timeEstimate > 0 and the option is enabled
 *   [repeats: <rule>]    inbound-preserved recurrence we cannot recreate in SP
 */

const SP_MARKER_RE = /\[sp:([^\]]+)\]/i;
const ESTIMATE_MARKER_RE = /\[estimate:\s*([^\]]+)\]/i;
const REPEATS_MARKER_RE = /\[repeats:\s*([^\]]+)\]/i;

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_MINUTE = 60 * 1000;

// ---- Marker parsing / stripping --------------------------------------------

export const extractSpTaskId = (notes: string | undefined): string | null => {
  if (!notes) return null;
  const m = notes.match(SP_MARKER_RE);
  return m ? m[1].trim() : null;
};

export const extractRepeatRule = (notes: string | undefined): string | null => {
  if (!notes) return null;
  const m = notes.match(REPEATS_MARKER_RE);
  return m ? m[1].trim() : null;
};

/**
 * Parse an `[estimate: ...]` marker into milliseconds. Accepts forms like
 * "2h", "30m", "1h30m", "90m", "1.5h". Returns 0 when absent/unparseable.
 */
export const parseEstimateMarker = (notes: string | undefined): number => {
  if (!notes) return 0;
  const m = notes.match(ESTIMATE_MARKER_RE);
  if (!m) return 0;
  const text = m[1].trim().toLowerCase();
  let ms = 0;
  let matchedAny = false;
  const hMatch = text.match(/([\d.]+)\s*h/);
  if (hMatch) {
    ms += parseFloat(hMatch[1]) * MS_PER_HOUR;
    matchedAny = true;
  }
  const mMatch = text.match(/([\d.]+)\s*m/);
  if (mMatch) {
    ms += parseFloat(mMatch[1]) * MS_PER_MINUTE;
    matchedAny = true;
  }
  if (!matchedAny) {
    // Bare number => treat as hours.
    const n = parseFloat(text);
    if (!Number.isNaN(n)) ms = n * MS_PER_HOUR;
  }
  return Math.round(ms);
};

/** Format milliseconds into a compact estimate string for the marker. */
export const formatEstimate = (ms: number): string => {
  if (ms <= 0) return '0m';
  const totalMinutes = Math.round(ms / MS_PER_MINUTE);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours && minutes) return `${hours}h${minutes}m`;
  if (hours) return `${hours}h`;
  return `${minutes}m`;
};

/** Remove ALL plugin markers from a note string and tidy whitespace. */
export const stripAllMarkers = (notes: string | undefined): string => {
  if (!notes) return '';
  return notes
    .replace(SP_MARKER_RE, '')
    .replace(ESTIMATE_MARKER_RE, '')
    .replace(REPEATS_MARKER_RE, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

/**
 * Build the note body to write to remi: the user's SP notes plus the hidden
 * markers. The sp marker is always appended for correlation.
 */
export const buildReminderNotes = (
  task: Task,
  opts: { syncEstimate: boolean; preservedRepeatRule?: string | null },
): string => {
  const userNotes = stripAllMarkers(task.notes);
  const markers: string[] = [];
  if (opts.syncEstimate && task.timeEstimate > 0) {
    markers.push(`[estimate: ${formatEstimate(task.timeEstimate)}]`);
  }
  if (opts.preservedRepeatRule) {
    markers.push(`[repeats: ${opts.preservedRepeatRule}]`);
  }
  markers.push(`[sp:${task.id}]`);
  const markerBlock = markers.join(' ');
  return userNotes ? `${userNotes}\n\n${markerBlock}` : markerBlock;
};

// ---- Dates ------------------------------------------------------------------

/**
 * Compute the remi `--due` value (YYYY-MM-DD) for an SP task, or null if it has
 * no due date. remi is date-only, so a dueWithTime is downgraded to its date.
 * Uses LOCAL date components (the reminder's calendar day should match the
 * user's local perception of the due day).
 */
export const spDueToRemiDate = (task: Task): string | null => {
  if (task.dueDay) return task.dueDay; // already YYYY-MM-DD (local day)
  if (task.dueWithTime) return epochToLocalYmd(task.dueWithTime);
  return null;
};

export const epochToLocalYmd = (epochMs: number): string => {
  const d = new Date(epochMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

/** The local YYYY-MM-DD an SP task currently represents (day or time-of-day). */
export const spCurrentDueYmd = (task: Task): string | null => {
  if (task.dueDay) return task.dueDay;
  if (task.dueWithTime) return epochToLocalYmd(task.dueWithTime);
  return null;
};

// ---- Recurrence (SP repeat cfg -> remi --repeat) ----------------------------

export interface SimpleRepeatCfg {
  repeatCycle: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  repeatEvery: number;
  monday?: boolean;
  tuesday?: boolean;
  wednesday?: boolean;
  thursday?: boolean;
  friday?: boolean;
  saturday?: boolean;
  sunday?: boolean;
}

const CYCLE_WORD: Record<SimpleRepeatCfg['repeatCycle'], string> = {
  DAILY: 'daily',
  WEEKLY: 'weekly',
  MONTHLY: 'monthly',
  YEARLY: 'yearly',
};

const CYCLE_UNIT: Record<SimpleRepeatCfg['repeatCycle'], string> = {
  DAILY: 'day',
  WEEKLY: 'week',
  MONTHLY: 'month',
  YEARLY: 'year',
};

const WEEKDAY_ORDER: (keyof SimpleRepeatCfg)[] = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];

/**
 * Translate an SP repeat config into a remi `--repeat` string.
 * Examples:
 *   {DAILY, every 1}                 -> "daily"
 *   {WEEKLY, every 2}                -> "every 2 weeks"
 *   {WEEKLY, every 1, mon+fri}       -> "weekly on monday,friday"
 *   {MONTHLY, every 3}               -> "every 3 months"
 * Returns null if the cfg cannot be represented.
 */
export const repeatCfgToRemi = (cfg: SimpleRepeatCfg): string | null => {
  if (!cfg || !cfg.repeatCycle || cfg.repeatEvery < 1) return null;

  let base: string;
  if (cfg.repeatEvery === 1) {
    base = CYCLE_WORD[cfg.repeatCycle];
  } else {
    base = `every ${cfg.repeatEvery} ${CYCLE_UNIT[cfg.repeatCycle]}s`;
  }

  if (cfg.repeatCycle === 'WEEKLY') {
    const days = WEEKDAY_ORDER.filter((d) => cfg[d]);
    if (days.length > 0 && days.length < 7) {
      base += ` on ${days.join(',')}`;
    }
  }
  return base;
};

// ---- Fingerprinting (change detection) --------------------------------------

/**
 * A stable fingerprint of the SP-relevant fields we push to remi. Used to
 * detect whether the SP side actually changed since last sync (vs. an echo).
 */
export const fingerprintSpTask = (
  task: Task,
  firstTagName: string | null,
): string =>
  JSON.stringify([
    task.title,
    stripAllMarkers(task.notes),
    task.isDone,
    spDueToRemiDate(task),
    task.timeEstimate,
    firstTagName || '',
  ]);

/** A stable fingerprint of the reminder fields we care about. */
export const fingerprintReminder = (r: Reminder): string =>
  JSON.stringify([
    r.title,
    stripAllMarkers(r.notes),
    r.isCompleted,
    r.dueDate || null,
    parseEstimateMarker(r.notes),
    r.section || '',
  ]);

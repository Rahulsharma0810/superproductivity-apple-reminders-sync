// The JSON shape emitted by `remi --json` for reminders, lists, and sections.
// Mirrors remi v0.1.0's src/types.ts. Kept in `shared` so both the background
// sync code and (potentially) the UI can reference it.

export type RemiPriority = 'none' | 'low' | 'medium' | 'high';

export interface Reminder {
  id: string;
  title: string;
  isCompleted: boolean;
  listID: string;
  listName: string;
  priority: RemiPriority;
  /** Always 'YYYY-MM-DD' (remi is date-only, no time-of-day). */
  dueDate?: string;
  completionDate?: string;
  notes?: string;
  /** Only present when Full Disk Access + section-helper are available. */
  section?: string;
  isRecurring?: boolean;
  /** e.g. 'weekly', 'every 2 weeks on monday,friday'. */
  recurrence?: string;
  flagged?: boolean;
}

export interface ReminderList {
  id: string;
  title: string;
  reminderCount: number;
  overdueCount: number;
}

export interface ReminderSection {
  id: string;
  displayName: string;
  listName: string;
  sortOrder: number;
}

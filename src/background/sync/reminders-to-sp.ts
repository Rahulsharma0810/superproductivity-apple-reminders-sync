import { PluginCreateTaskData, Tag, Task } from '@super-productivity/plugin-api';
import { SyncConfig } from '../../shared/types';
import { MappingStore } from './mapping-store';
import { Reminder, SyncPassResult, emptyPassResult } from './types';
import {
  extractSpTaskId,
  fingerprintReminder,
  parseEstimateMarker,
  spCurrentDueYmd,
  stripAllMarkers,
} from './field-mapping';
import { remiListReminders, RemiPermissionError } from '../helper/remi-helper';
import { log } from '../../shared/logger';

/**
 * INBOUND sync: Apple Reminders -> SP tasks for a single project<->list pair.
 *
 * Correlation order for each reminder:
 *   1. MappingStore.getByReminderId (fast path)
 *   2. `[sp:<taskId>]` marker embedded in notes (fallback / recovery)
 *   3. otherwise NEW -> addTask
 *
 * Change application uses updateTask/addTask/deleteTask (NOT
 * batchUpdateForProject) because we need date and tag fields the batch API
 * does not accept.
 *
 * Date rule (anti-data-loss): remi is date-only. We set SP dueDay ONLY when the
 * Apple date differs from the SP task's current due day, and never touch an
 * existing dueWithTime unless the calendar day actually changed.
 */

interface InboundContext {
  config: SyncConfig;
  store: MappingStore;
  /** Notifier the manager passes in to show the one-time recurrence hint. */
  onRecurringImported: () => void;
}

/** Resolve (or create) a tag by title and return its id. */
const resolveTagId = async (
  sectionName: string,
  tagCache: Map<string, string>,
): Promise<string> => {
  const key = sectionName.toLowerCase();
  const cached = tagCache.get(key);
  if (cached) return cached;

  const tags = await PluginAPI.getAllTags();
  const existing = tags.find(
    (t: Tag) => t.title.toLowerCase() === sectionName.toLowerCase(),
  );
  if (existing) {
    tagCache.set(key, existing.id);
    return existing.id;
  }
  const newId = await PluginAPI.addTag({ title: sectionName });
  tagCache.set(key, newId);
  return newId;
};

/** Build the tagIds a task should have, merging any section-derived tag. */
const mergeTagIds = (current: string[], sectionTagId: string | null): string[] => {
  if (!sectionTagId) return current;
  if (current.includes(sectionTagId)) return current;
  return [...current, sectionTagId];
};

const importNewReminder = async (
  reminder: Reminder,
  projectId: string,
  ctx: InboundContext,
  tagCache: Map<string, string>,
  result: SyncPassResult,
): Promise<void> => {
  let sectionTagId: string | null = null;
  if (ctx.config.isSyncTagsAsSections && reminder.section) {
    try {
      sectionTagId = await resolveTagId(reminder.section, tagCache);
    } catch (err) {
      result.errors.push(`tag for section: ${(err as Error).message}`);
    }
  }

  const createData: PluginCreateTaskData = {
    title: reminder.title,
    projectId,
    notes: stripAllMarkers(reminder.notes),
    tagIds: sectionTagId ? [sectionTagId] : [],
  };
  const estimate = parseEstimateMarker(reminder.notes);
  if (estimate > 0) createData.timeEstimate = estimate;
  if (reminder.dueDate) createData.dueDay = reminder.dueDate;
  if (reminder.isCompleted) createData.isDone = true;

  const newTaskId = await PluginAPI.addTask(createData);

  ctx.store.upsert({
    taskId: newTaskId,
    reminderId: reminder.id,
    reminderListName: reminder.listName,
    lastSyncedTitle: reminder.title,
    lastSyncedFingerprint: fingerprintReminder(reminder),
  });
  result.created += 1;

  // Recurring reminder: we cannot create an SP repeat cfg via the plugin API,
  // so surface a one-time hint. The '[repeats: ...]' marker is preserved on the
  // reminder side by the outbound pass if the user re-syncs.
  if (reminder.isRecurring) {
    ctx.onRecurringImported();
  }
};

const updateExistingTask = async (
  task: Task,
  reminder: Reminder,
  ctx: InboundContext,
  tagCache: Map<string, string>,
  result: SyncPassResult,
): Promise<void> => {
  const newFingerprint = fingerprintReminder(reminder);
  const link = ctx.store.getByReminderId(reminder.id);
  if (link && link.lastSyncedFingerprint === newFingerprint) {
    // Reminder side unchanged since last sync — nothing to do inbound.
    result.skipped += 1;
    return;
  }

  const updates: Partial<Task> = {
    title: reminder.title,
    notes: stripAllMarkers(reminder.notes),
    isDone: reminder.isCompleted,
  };

  const estimate = parseEstimateMarker(reminder.notes);
  if (estimate > 0) updates.timeEstimate = estimate;

  // Date: only change when the Apple calendar day differs from the SP task's
  // current due day. This preserves an existing dueWithTime whose day matches.
  const currentYmd = spCurrentDueYmd(task);
  if (reminder.dueDate) {
    if (reminder.dueDate !== currentYmd) {
      updates.dueDay = reminder.dueDate;
      updates.dueWithTime = null; // mutually exclusive with dueDay
    }
  } else if (currentYmd) {
    // Apple cleared the due date.
    updates.dueDay = null;
    updates.dueWithTime = null;
  }

  if (ctx.config.isSyncTagsAsSections && reminder.section) {
    try {
      const sectionTagId = await resolveTagId(reminder.section, tagCache);
      updates.tagIds = mergeTagIds(task.tagIds, sectionTagId);
    } catch (err) {
      result.errors.push(`tag for section: ${(err as Error).message}`);
    }
  }

  await PluginAPI.updateTask(task.id, updates);

  ctx.store.upsert({
    taskId: task.id,
    reminderId: reminder.id,
    reminderListName: reminder.listName,
    lastSyncedTitle: reminder.title,
    lastSyncedFingerprint: newFingerprint,
  });
  result.updated += 1;
};

export const syncRemindersToProject = async (
  projectId: string,
  listName: string,
  ctx: InboundContext,
): Promise<SyncPassResult> => {
  const result = emptyPassResult();
  const remiBin = ctx.config.remiBinaryPath;

  const reminders = await remiListReminders(listName, remiBin, {
    includeCompleted: true,
    withSection: ctx.config.isSyncTagsAsSections,
  });
  const liveReminderIds = new Set(reminders.map((r) => r.id));

  const allTasks = await PluginAPI.getTasks();
  const tasksById = new Map<string, Task>(allTasks.map((t) => [t.id, t]));
  const tagCache = new Map<string, string>();

  // 1) Deletions: linked reminders that vanished from the list. includeCompleted
  //    means a missing reminder was truly deleted (not just completed-filtered),
  //    so delete the SP task to match.
  for (const link of ctx.store.allForList(listName)) {
    if (!liveReminderIds.has(link.reminderId)) {
      const task = tasksById.get(link.taskId);
      if (task) {
        try {
          await PluginAPI.deleteTask(task.id);
          result.deleted += 1;
        } catch (err) {
          result.errors.push(`deleteTask ${task.id}: ${(err as Error).message}`);
        }
      }
      ctx.store.removeByReminderId(link.reminderId);
    }
  }

  // 2) Create/update from each reminder.
  for (const reminder of reminders) {
    try {
      // Correlate: store first, then embedded marker.
      let taskId: string | null = null;
      const byId = ctx.store.getByReminderId(reminder.id);
      if (byId) {
        taskId = byId.taskId;
      } else {
        const markerId = extractSpTaskId(reminder.notes);
        if (markerId && tasksById.has(markerId)) {
          taskId = markerId;
          // Recovered link (e.g. mapping store was cleared) — re-establish it.
          ctx.store.upsert({
            taskId,
            reminderId: reminder.id,
            reminderListName: reminder.listName,
            lastSyncedTitle: reminder.title,
            lastSyncedFingerprint: '', // force update pass to run
          });
        }
      }

      if (taskId && tasksById.has(taskId)) {
        await updateExistingTask(
          tasksById.get(taskId) as Task,
          reminder,
          ctx,
          tagCache,
          result,
        );
      } else {
        await importNewReminder(reminder, projectId, ctx, tagCache, result);
      }
    } catch (err) {
      if (err instanceof RemiPermissionError) throw err;
      result.errors.push(`reminder ${reminder.id}: ${(err as Error).message}`);
    }
  }

  log.debug('[sync-reminders] inbound pass', {
    list: listName,
    created: result.created,
    updated: result.updated,
    deleted: result.deleted,
    skipped: result.skipped,
    errors: result.errors.length,
  });
  return result;
};

import { Task } from '@super-productivity/plugin-api';
import { SyncConfig } from '../../shared/types';
import { MappingStore } from './mapping-store';
import { SyncPassResult, emptyPassResult } from './types';
import {
  buildReminderNotes,
  fingerprintSpTask,
  repeatCfgToRemi,
  spDueToRemiDate,
  SimpleRepeatCfg,
} from './field-mapping';
import {
  remiAdd,
  remiComplete,
  remiCreateSection,
  remiDelete,
  remiMove,
  remiUpdate,
  RemiPermissionError,
} from '../helper/remi-helper';
import { log } from '../../shared/logger';

/**
 * OUTBOUND sync: SP tasks -> Apple Reminders for a single project<->list pair.
 *
 * Rules (see README field-mapping table):
 *  - Subtasks are flattened to top-level reminders (remi has no subtask concept).
 *  - New SP task with no link  => remi add (capture id), store link.
 *  - Linked SP task changed    => remi update (+ complete/uncomplete).
 *  - Linked SP task gone        => remi delete, drop link.
 *  - First tag -> section (opt-in; needs Full Disk Access, best-effort).
 *  - Recurrence only settable at add (remi update has no --repeat).
 */

interface TagLookup {
  /** Map of tagId -> tag title, for resolving the first tag name. */
  idToTitle: Map<string, string>;
}

const firstTagName = (task: Task, tags: TagLookup): string | null => {
  if (!task.tagIds || task.tagIds.length === 0) return null;
  const title = tags.idToTitle.get(task.tagIds[0]);
  return title && title.trim() ? title.trim() : null;
};

/** Resolve an SP repeat cfg id to the remi --repeat string (add-time only). */
const resolveRepeatRule = (
  task: Task,
  repeatCfgs: Readonly<Record<string, unknown>>,
): string | null => {
  if (!task.repeatCfgId) return null;
  const cfg = repeatCfgs[task.repeatCfgId] as SimpleRepeatCfg | undefined;
  if (!cfg) return null;
  return repeatCfgToRemi(cfg);
};

/**
 * Collect the tasks (flattened) that belong to a project, in a stable order:
 * parents in project.taskIds order, each followed by its subtasks.
 */
const collectProjectTasks = (allTasks: Task[], projectId: string): Task[] => {
  const inProject = allTasks.filter((t) => t.projectId === projectId);
  // Flattening: just return all tasks in the project (parents + subtasks) as a
  // flat list. Order isn't critical for reminders, but keep parents first.
  const parents = inProject.filter((t) => !t.parentId);
  const children = inProject.filter((t) => t.parentId);
  return [...parents, ...children];
};

const applySection = async (
  listName: string,
  reminderTitle: string,
  sectionName: string | null,
  remiBin: string,
  result: SyncPassResult,
): Promise<void> => {
  if (!sectionName) return;
  try {
    // create-section is idempotent-ish; ignore "already exists" style errors.
    await remiCreateSection(listName, sectionName, remiBin).catch(() => undefined);
    await remiMove(listName, reminderTitle, sectionName, remiBin);
  } catch (err) {
    // Sections need Full Disk Access; degrade gracefully.
    if (err instanceof RemiPermissionError) throw err;
    result.errors.push(`section '${sectionName}': ${(err as Error).message}`);
  }
};

export const syncProjectToReminders = async (
  mappingProjectId: string,
  listName: string,
  config: SyncConfig,
  store: MappingStore,
  tags: TagLookup,
): Promise<SyncPassResult> => {
  const result = emptyPassResult();
  const remiBin = config.remiBinaryPath;

  const allTasks = await PluginAPI.getTasks();
  const projectTasks = collectProjectTasks(allTasks, mappingProjectId);
  const liveTaskIds = new Set(projectTasks.map((t) => t.id));

  const appState = await PluginAPI.getAppState();
  const repeatCfgs = (appState?.taskRepeatCfgs || {}) as Readonly<
    Record<string, unknown>
  >;

  // 1) Handle deletions: links for this list whose SP task no longer exists.
  for (const link of store.allForList(listName)) {
    if (!liveTaskIds.has(link.taskId)) {
      try {
        await remiDelete(listName, link.lastSyncedTitle, link.reminderId, remiBin);
        store.removeByTaskId(link.taskId);
        result.deleted += 1;
      } catch (err) {
        if (err instanceof RemiPermissionError) throw err;
        result.errors.push(`delete ${link.taskId}: ${(err as Error).message}`);
      }
    }
  }

  // 2) Create / update each live task.
  for (const task of projectTasks) {
    const tagName = firstTagName(task, tags);
    const fingerprint = fingerprintSpTask(task, tagName);
    const link = store.getByTaskId(task.id);
    const due = spDueToRemiDate(task);

    if (!link) {
      // New reminder.
      try {
        const repeatRule = resolveRepeatRule(task, repeatCfgs);
        const notes = buildReminderNotes(task, {
          syncEstimate: config.isSyncEstimateInNotes,
          preservedRepeatRule: null,
        });
        const addRes = await remiAdd(listName, task.title, remiBin, {
          due: due || undefined,
          notes,
          repeat: repeatRule || undefined,
          section:
            config.isSyncTagsAsSections && tagName ? tagName : undefined,
        });
        store.upsert({
          taskId: task.id,
          reminderId: addRes.id,
          reminderListName: listName,
          lastSyncedTitle: task.title,
          lastSyncedFingerprint: fingerprint,
        });
        // Newly-created but already-done task: mark complete.
        if (task.isDone) {
          await remiComplete(listName, task.title, addRes.id, remiBin).catch(
            (err) => {
              if (err instanceof RemiPermissionError) throw err;
              result.errors.push(
                `complete new ${task.id}: ${(err as Error).message}`,
              );
            },
          );
        }
        result.created += 1;
      } catch (err) {
        if (err instanceof RemiPermissionError) throw err;
        result.errors.push(`add ${task.id}: ${(err as Error).message}`);
      }
      continue;
    }

    // Existing link: skip if nothing we care about changed.
    if (link.lastSyncedFingerprint === fingerprint) {
      result.skipped += 1;
      continue;
    }

    // Update the reminder. remi matches by CURRENT (last-synced) title.
    try {
      const notes = buildReminderNotes(task, {
        syncEstimate: config.isSyncEstimateInNotes,
        preservedRepeatRule: null,
      });
      const titleChanged = task.title !== link.lastSyncedTitle;
      await remiUpdate(listName, link.lastSyncedTitle, remiBin, {
        newTitle: titleChanged ? task.title : undefined,
        due: due || undefined,
        clearDue: !due,
        notes,
      });

      // Completion state — remi complete/done sets completed; use --id for
      // reliability. (Un-complete via remi is unverified; see README TODO.)
      if (task.isDone) {
        await remiComplete(listName, task.title, link.reminderId, remiBin).catch(
          (err) => {
            if (err instanceof RemiPermissionError) throw err;
            result.errors.push(`complete ${task.id}: ${(err as Error).message}`);
          },
        );
      }

      if (config.isSyncTagsAsSections) {
        await applySection(listName, task.title, tagName, remiBin, result);
      }

      store.upsert({
        taskId: task.id,
        reminderId: link.reminderId,
        reminderListName: listName,
        lastSyncedTitle: task.title,
        lastSyncedFingerprint: fingerprint,
      });
      result.updated += 1;
    } catch (err) {
      if (err instanceof RemiPermissionError) throw err;
      result.errors.push(`update ${task.id}: ${(err as Error).message}`);
    }
  }

  log.debug('[sync-reminders] outbound pass', {
    list: listName,
    created: result.created,
    updated: result.updated,
    deleted: result.deleted,
    skipped: result.skipped,
    errors: result.errors.length,
  });
  return result;
};

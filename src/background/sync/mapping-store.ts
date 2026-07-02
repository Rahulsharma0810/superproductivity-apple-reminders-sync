import { MappingStoreData, TaskLink } from './types';
import { log } from '../../shared/logger';

/**
 * Persistent correlation store between SP task ids and Apple reminder ids.
 *
 * Stored DEVICE-LOCAL (localStorage), deliberately NOT via persistDataSynced:
 * reminder ids are device/iCloud-scoped and meaningless on another machine, and
 * the config that drives sync is itself device-local. Keeping the map local
 * avoids polluting sync/backups with per-device ids.
 */
const STORAGE_KEY = 'sync-reminders-mapping';

export class MappingStore {
  private links: TaskLink[] = [];
  private byTaskId = new Map<string, TaskLink>();
  private byReminderId = new Map<string, TaskLink>();

  load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        this.links = [];
      } else {
        const parsed = JSON.parse(raw) as MappingStoreData;
        this.links = Array.isArray(parsed?.links) ? parsed.links : [];
      }
    } catch (err) {
      log.err('Failed to load mapping store, starting empty', err);
      this.links = [];
    }
    this.reindex();
  }

  private reindex(): void {
    this.byTaskId.clear();
    this.byReminderId.clear();
    for (const link of this.links) {
      this.byTaskId.set(link.taskId, link);
      this.byReminderId.set(link.reminderId, link);
    }
  }

  private persist(): void {
    const data: MappingStoreData = { version: 1, links: this.links };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (err) {
      log.err('Failed to persist mapping store', err);
    }
  }

  getByTaskId(taskId: string): TaskLink | undefined {
    return this.byTaskId.get(taskId);
  }

  getByReminderId(reminderId: string): TaskLink | undefined {
    return this.byReminderId.get(reminderId);
  }

  allForList(listName: string): TaskLink[] {
    return this.links.filter((l) => l.reminderListName === listName);
  }

  upsert(link: TaskLink): void {
    const existing = this.byTaskId.get(link.taskId);
    if (existing) {
      Object.assign(existing, link);
    } else {
      this.links.push(link);
    }
    this.reindex();
    this.persist();
  }

  removeByTaskId(taskId: string): void {
    const existing = this.byTaskId.get(taskId);
    if (!existing) return;
    this.links = this.links.filter((l) => l.taskId !== taskId);
    this.reindex();
    this.persist();
  }

  removeByReminderId(reminderId: string): void {
    const existing = this.byReminderId.get(reminderId);
    if (!existing) return;
    this.links = this.links.filter((l) => l.reminderId !== reminderId);
    this.reindex();
    this.persist();
  }

  /** Drop links whose list is no longer in the active mapping set. */
  pruneListsNotIn(activeListNames: Set<string>): void {
    const before = this.links.length;
    this.links = this.links.filter((l) => activeListNames.has(l.reminderListName));
    if (this.links.length !== before) {
      this.reindex();
      this.persist();
    }
  }

  size(): number {
    return this.links.length;
  }
}

import { MappingStore } from '../sync/mapping-store';
import { TaskLink } from '../sync/types';

const link = (over: Partial<TaskLink> = {}): TaskLink => ({
  taskId: 'task-1',
  reminderId: 'rem-1',
  reminderListName: 'Inbox',
  lastSyncedTitle: 'A task',
  lastSyncedFingerprint: 'fp-1',
  ...over,
});

describe('MappingStore', () => {
  let store: MappingStore;

  beforeEach(() => {
    // localStorage is cleared in setupTests beforeEach.
    store = new MappingStore();
    store.load();
  });

  it('starts empty', () => {
    expect(store.size()).toBe(0);
    expect(store.getByTaskId('task-1')).toBeUndefined();
    expect(store.getByReminderId('rem-1')).toBeUndefined();
  });

  it('upserts and looks up by task id and reminder id', () => {
    store.upsert(link());
    expect(store.size()).toBe(1);
    expect(store.getByTaskId('task-1')?.reminderId).toBe('rem-1');
    expect(store.getByReminderId('rem-1')?.taskId).toBe('task-1');
  });

  it('upsert updates an existing link in place (no duplicate)', () => {
    store.upsert(link());
    store.upsert(link({ lastSyncedTitle: 'Renamed', lastSyncedFingerprint: 'fp-2' }));
    expect(store.size()).toBe(1);
    expect(store.getByTaskId('task-1')?.lastSyncedTitle).toBe('Renamed');
    expect(store.getByTaskId('task-1')?.lastSyncedFingerprint).toBe('fp-2');
  });

  it('re-indexes reminderId when an upsert changes it', () => {
    store.upsert(link());
    store.upsert(link({ reminderId: 'rem-2' }));
    expect(store.getByReminderId('rem-2')?.taskId).toBe('task-1');
    // old reminder id should no longer resolve to this link
    expect(store.getByReminderId('rem-1')).toBeUndefined();
  });

  it('removeByTaskId drops the link from both indexes', () => {
    store.upsert(link());
    store.removeByTaskId('task-1');
    expect(store.size()).toBe(0);
    expect(store.getByTaskId('task-1')).toBeUndefined();
    expect(store.getByReminderId('rem-1')).toBeUndefined();
  });

  it('removeByReminderId drops the link from both indexes', () => {
    store.upsert(link());
    store.removeByReminderId('rem-1');
    expect(store.size()).toBe(0);
    expect(store.getByTaskId('task-1')).toBeUndefined();
    expect(store.getByReminderId('rem-1')).toBeUndefined();
  });

  it('remove* is a no-op for unknown ids', () => {
    store.upsert(link());
    store.removeByTaskId('nope');
    store.removeByReminderId('nope');
    expect(store.size()).toBe(1);
  });

  it('allForList filters by list name', () => {
    store.upsert(link({ taskId: 't1', reminderId: 'r1', reminderListName: 'Inbox' }));
    store.upsert(link({ taskId: 't2', reminderId: 'r2', reminderListName: 'Work' }));
    store.upsert(link({ taskId: 't3', reminderId: 'r3', reminderListName: 'Inbox' }));
    const inbox = store.allForList('Inbox');
    expect(inbox.map((l) => l.taskId).sort()).toEqual(['t1', 't3']);
    expect(store.allForList('Work').map((l) => l.taskId)).toEqual(['t2']);
    expect(store.allForList('Missing')).toEqual([]);
  });

  it('pruneListsNotIn removes links whose list is not active', () => {
    store.upsert(link({ taskId: 't1', reminderId: 'r1', reminderListName: 'Inbox' }));
    store.upsert(link({ taskId: 't2', reminderId: 'r2', reminderListName: 'Old' }));
    store.pruneListsNotIn(new Set(['Inbox']));
    expect(store.size()).toBe(1);
    expect(store.getByTaskId('t1')).toBeDefined();
    expect(store.getByTaskId('t2')).toBeUndefined();
  });

  it('persists across instances via localStorage', () => {
    store.upsert(link({ taskId: 'persist-1', reminderId: 'persist-r1' }));
    const fresh = new MappingStore();
    fresh.load();
    expect(fresh.size()).toBe(1);
    expect(fresh.getByTaskId('persist-1')?.reminderId).toBe('persist-r1');
  });

  it('tolerates corrupt localStorage payload by starting empty', () => {
    localStorage.setItem('sync-reminders-mapping', '{not valid json');
    const fresh = new MappingStore();
    fresh.load();
    expect(fresh.size()).toBe(0);
  });
});

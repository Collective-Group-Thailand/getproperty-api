import { bangkokDayEnd, groupTasks, type StaffTask, taskPriority } from './staff-task-rules';

const task = (over: Partial<StaffTask>): StaffTask => ({
  type: 'work_order',
  id: 'x',
  buildingId: 'b',
  unitId: null,
  unitNo: null,
  floorId: null,
  floorName: null,
  floorLevel: null,
  sourceStatus: 'open',
  priority: 'normal',
  overdue: false,
  dueAt: null,
  assigneeUserId: null,
  subject: '',
  assetItemId: null,
  createdAt: new Date('2026-11-01T00:00:00Z'),
  completable: true,
  ...over,
});

describe('staff task rules (B5.4)', () => {
  const now = new Date('2026-11-02T03:00:00Z');

  it('raises an overdue task to high, never lowers', () => {
    expect(taskPriority('normal', null, now)).toBe('normal');
    expect(taskPriority('low', new Date('2026-11-02T02:00:00Z'), now)).toBe('high');
    expect(taskPriority('urgent', new Date('2026-11-02T02:00:00Z'), now)).toBe('urgent');
    expect(taskPriority('normal', new Date('2026-11-02T04:00:00Z'), now)).toBe('normal');
    expect(taskPriority('bogus', null, now)).toBe('low');
  });

  it('ends a Bangkok day at the next local midnight', () => {
    expect(bangkokDayEnd('2026-11-02').toISOString()).toBe('2026-11-02T17:00:00.000Z');
  });

  it('groups by type, then floor by level, most urgent first', () => {
    const groups = groupTasks([
      task({ id: 'p1', type: 'parcel', floorId: 'f2', floorLevel: 2 }),
      task({ id: 'w1', floorId: 'f2', floorLevel: 2, priority: 'normal' }),
      task({ id: 'w2', floorId: 'f2', floorLevel: 2, priority: 'urgent' }),
      task({ id: 'w3', floorId: 'f1', floorLevel: 1 }),
      task({ id: 'w4' }),
      task({ id: 'i1', type: 'install' }),
    ]);
    expect(groups.map((g) => [g.type, g.count])).toEqual([
      ['work_order', 4],
      ['parcel', 1],
      ['install', 1],
    ]);
    expect(groups[0]!.floors.map((f) => f.floorId)).toEqual([null, 'f1', 'f2']);
    expect(groups[0]!.floors[2]!.tasks.map((t) => t.id)).toEqual(['w2', 'w1']);
  });
});

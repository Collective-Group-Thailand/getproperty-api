import { ADMIN_MENU, OWNER_MENU, STAFF_MENU } from '@core/rbac/menu';

import { AdminMenuKey, OwnerMenuKey, StaffMenuKey } from './status.enums';

describe('menu keys are named enums in step with the menu catalogue (web contract request)', () => {
  it.each([
    ['OwnerMenuKey', OWNER_MENU, OwnerMenuKey],
    ['StaffMenuKey', STAFF_MENU, StaffMenuKey],
    ['AdminMenuKey', ADMIN_MENU, AdminMenuKey],
  ] as const)('%s', (_name, menu, keys) => {
    expect(menu.map((m) => m.key).sort()).toEqual(Object.values(keys).sort());
  });
});

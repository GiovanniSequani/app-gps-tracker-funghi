import { beforeEach, describe, expect, it, vi } from 'vitest';

const execAsync = vi.fn(async () => undefined);
const runAsync = vi.fn(async () => ({ changes: 1, lastInsertRowId: 1 }));
const getFirstAsync = vi.fn(async () => null);
const getAllAsync = vi.fn(async (sql: string) => {
  if (sql.includes('PRAGMA table_info(routes)')) return [{ name: 'route_id' }];
  if (sql.includes('PRAGMA table_info(waypoints)')) return [{ name: 'route_id' }];
  return [];
});
const database = {
  execAsync,
  runAsync,
  getFirstAsync,
  getAllAsync,
  withTransactionAsync: vi.fn(async (callback: () => Promise<void>) => callback()),
};

vi.mock('expo-sqlite', () => ({
  openDatabaseAsync: vi.fn(async () => database),
}));

import { deleteRoute, getAllRoutes, getRouteById, initDB, insertRoute } from '../../../db';

describe('isolamento archivio locale per account', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    getAllAsync.mockImplementation(async (sql: string) => {
      if (sql.includes('PRAGMA table_info(routes)')) return [{ name: 'route_id' }];
      if (sql.includes('PRAGMA table_info(waypoints)')) return [{ name: 'route_id' }];
      return [];
    });
    await initDB();
  });

  it('elimina i record legacy senza owner durante la migrazione fail-closed', () => {
    expect(execAsync).toHaveBeenCalledWith('ALTER TABLE routes ADD COLUMN owner_user_id TEXT;');
    expect(execAsync).toHaveBeenCalledWith('ALTER TABLE waypoints ADD COLUMN owner_user_id TEXT;');
    expect(runAsync).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM routes WHERE owner_user_id IS NULL'),
      [''],
    );
  });

  it('filtra metadata, percorso e waypoint usando sempre lo stesso owner', async () => {
    await getAllRoutes('user-b');
    expect(getAllAsync).toHaveBeenLastCalledWith(
      expect.stringContaining('WHERE owner_user_id = ?'),
      ['user-b'],
    );

    getFirstAsync.mockResolvedValueOnce(null);
    expect(await getRouteById('user-b', 'route-of-user-a')).toBeNull();
    expect(getFirstAsync).toHaveBeenCalledWith(
      expect.stringContaining('route_id = ? AND owner_user_id = ?'),
      ['route-of-user-a', 'user-b'],
    );
  });

  it('scrive e cancella route e marker soltanto nello scope proprietario', async () => {
    await insertRoute(
      'user-a',
      'route-1',
      'Bosco',
      '2026-09-14T08:00:00.000Z',
      [{ latitude: 45, longitude: 11, timestamp: 1 }],
      [{ latitude: 45, longitude: 11, timestamp: 1, name: 'Porcino_1', tipo: 'Porcino' }],
    );
    expect(runAsync).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO routes (route_id, owner_user_id'),
      expect.arrayContaining(['route-1', 'user-a']),
    );
    expect(runAsync).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO waypoints (route_id, owner_user_id'),
      expect.arrayContaining(['route-1', 'user-a']),
    );

    await deleteRoute('user-a', 'route-1');
    expect(runAsync).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM routes WHERE route_id = ? AND owner_user_id = ?'),
      ['route-1', 'user-a'],
    );
  });

  it('rifiuta letture senza identita verificata', async () => {
    await expect(getAllRoutes('')).rejects.toThrow(/owner/i);
    await expect(getRouteById('', 'route-1')).rejects.toThrow(/owner/i);
  });
});

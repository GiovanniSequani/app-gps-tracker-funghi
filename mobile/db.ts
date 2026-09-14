// db.ts
import * as SQLite from 'expo-sqlite';

export type Coordinate = {
  latitude: number;
  longitude: number;
  timestamp: number;
};

export type Route = {
  route_id: string;
  owner_user_id: string;
  name: string;
  date: string;
  path: string;
};

export type Waypoint = {
    owner_user_id: string;
    lat: number; 
    lon: number; 
    timestamp: number; 
    name: string; 
    type: string;
};



let db: SQLite.SQLiteDatabase | null = null;

function requireOwnerUserId(ownerUserId: string): string {
  const normalized = ownerUserId.trim();
  if (!normalized) throw new Error('Account owner required');
  return normalized;
}

// Inizializza il DB
export const initDB = async () => {
  try {
    db = await SQLite.openDatabaseAsync('routes.db');
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS routes (
        route_id TEXT PRIMARY KEY NOT NULL,
        owner_user_id TEXT,
        name TEXT,
        date TEXT,
        path TEXT
      );
      CREATE TABLE IF NOT EXISTS waypoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        route_id TEXT,
        owner_user_id TEXT,
        lat REAL,
        lon REAL,
        timestamp INTEGER,
        name TEXT,
        type TEXT
      );
    `);
    const routeColumns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(routes);');
    if (!routeColumns.some((column) => column.name === 'owner_user_id')) {
      await db.execAsync('ALTER TABLE routes ADD COLUMN owner_user_id TEXT;');
    }
    const waypointColumns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(waypoints);');
    if (!waypointColumns.some((column) => column.name === 'owner_user_id')) {
      await db.execAsync('ALTER TABLE waypoints ADD COLUMN owner_user_id TEXT;');
    }
    // I record precedenti non hanno un proprietario verificabile: eliminarli e'
    // l'unico comportamento fail-closed che evita attribuzioni cross-account.
    await db.withTransactionAsync(async () => {
      await db!.runAsync('DELETE FROM waypoints WHERE owner_user_id IS NULL OR owner_user_id = ?;', ['']);
      await db!.runAsync('DELETE FROM routes WHERE owner_user_id IS NULL OR owner_user_id = ?;', ['']);
    });
  } catch {
    console.error('Errore initDB');
    throw new Error('DB initialization failed');
  }
};

// Inserisce un percorso con i suoi waypoints
export const insertRoute = async (
  owner_user_id: string,
  route_id: string,
  name: string,
  date: string,
  path: { latitude: number; longitude: number; timestamp: number }[],
  waypoints: { latitude: number; longitude: number; timestamp: number; name: string; tipo: string }[]
) => {
  if (!db) throw new Error('DB not initialized');
  const ownerUserId = requireOwnerUserId(owner_user_id);
  try {
    await db.withTransactionAsync(async () => {
      await db!.runAsync(
        `INSERT INTO routes (route_id, owner_user_id, name, date, path) VALUES (?, ?, ?, ?, ?);`,
        [route_id, ownerUserId, name, date, JSON.stringify(path)]
      );
      for (const wp of waypoints) {
        await db!.runAsync(
          `INSERT INTO waypoints (route_id, owner_user_id, lat, lon, timestamp, name, type) VALUES (?, ?, ?, ?, ?, ?, ?);`,
          [route_id, ownerUserId, wp.latitude, wp.longitude, wp.timestamp, wp.name, wp.tipo]
        );
      }
    });
    console.log('Route inserted');
  } catch (err) {
    console.error('Insert route error');
    throw err;
  }
};

// Restituisce tutti i percorsi (solo metadati)
export const getAllRoutes = async (owner_user_id: string) => {
  if (!db) throw new Error('DB not initialized');
  const ownerUserId = requireOwnerUserId(owner_user_id);
  try {
    return await db.getAllAsync(
      `SELECT route_id, name, date FROM routes WHERE owner_user_id = ? ORDER BY date DESC;`,
      [ownerUserId]
    );
  } catch {
    console.error('getAllRoutes error');
    return [];
  }
};

// Restituisce un percorso completo (path + waypoints)
export const getRouteById = async (owner_user_id: string, route_id: string) => {
  if (!db) throw new Error('DB not initialized');
  const ownerUserId = requireOwnerUserId(owner_user_id);
  try {
    const route = await db.getFirstAsync(
      `SELECT * FROM routes WHERE route_id = ? AND owner_user_id = ?;`,
      [route_id, ownerUserId]
    ) as Route | null;
    if (!route) return null;

    const waypoints = await db.getAllAsync(
      `SELECT * FROM waypoints WHERE route_id = ? AND owner_user_id = ?;`,
      [route_id, ownerUserId]
    ) as Waypoint[];

    return {
      ...route,
      path: JSON.parse(route.path) as Coordinate[],
      waypoints,
    };
  } catch {
    console.error('getRouteById error');
    return null;
  }
};

// Elimina un percorso e i suoi waypoints
export const deleteRoute = async (owner_user_id: string, route_id: string) => {
  if (!db) throw new Error('DB not initialized');
  const ownerUserId = requireOwnerUserId(owner_user_id);
  try {
    await db.withTransactionAsync(async () => {
      await db!.runAsync(`DELETE FROM waypoints WHERE route_id = ? AND owner_user_id = ?;`, [route_id, ownerUserId]);
      await db!.runAsync(`DELETE FROM routes WHERE route_id = ? AND owner_user_id = ?;`, [route_id, ownerUserId]);
    });
    console.log('Route deleted');
  } catch (err) {
    console.error('Delete route error');
    throw err;
  }
};

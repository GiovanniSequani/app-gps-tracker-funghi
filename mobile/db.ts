// db.ts
import * as SQLite from 'expo-sqlite';

export type Coordinate = {
  latitude: number;
  longitude: number;
  timestamp: number;
};

export type Route = {
  route_id: string;
  name: string;
  date: string;
  path: string;
};

export type Waypoint = {
    lat: number; 
    lon: number; 
    timestamp: number; 
    name: string; 
    type: string;
};



let db: SQLite.SQLiteDatabase | null = null;

// Inizializza il DB
export const initDB = async () => {
  try {
    db = await SQLite.openDatabaseAsync('routes.db');
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS routes (
        route_id TEXT PRIMARY KEY NOT NULL,
        name TEXT,
        date TEXT,
        path TEXT
      );
      CREATE TABLE IF NOT EXISTS waypoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        route_id TEXT,
        lat REAL,
        lon REAL,
        timestamp INTEGER,
        name TEXT,
        type TEXT
      );
    `);
  } catch (err) {
    console.error('Errore initDB:', err);
  }
};

// Inserisce un percorso con i suoi waypoints
export const insertRoute = async (
  route_id: string,
  name: string,
  date: string,
  path: { latitude: number; longitude: number; timestamp: number }[],
  waypoints: { latitude: number; longitude: number; timestamp: number; name: string; tipo: string }[]
) => {
  if (!db) throw new Error('DB not initialized');
  try {
    await db.runAsync(
      `INSERT INTO routes (route_id, name, date, path) VALUES (?, ?, ?, ?);`,
      [route_id, name, date, JSON.stringify(path)]
    );
    console.log(`Inserted route ${route_id} with path: ${JSON.stringify(path)}`);
    for (const wp of waypoints) {
      await db.runAsync(
        `INSERT INTO waypoints (route_id, lat, lon, timestamp, name, type) VALUES (?, ?, ?, ?, ?, ?);`,
        [route_id, wp.latitude, wp.longitude, wp.timestamp, wp.name, wp.tipo]
      );
        console.log(`Inserted waypoint for route ${route_id}: lat:${wp.latitude}, lon:${wp.longitude}, ts:${wp.timestamp}, name:${wp.name}, tipo:${wp.tipo}`);
    }
    console.log('Route inserted');
  } catch (err) {
    console.error('Insert route error:', err);
    throw err;
  }
};

// Restituisce tutti i percorsi (solo metadati)
export const getAllRoutes = async () => {
  if (!db) throw new Error('DB not initialized');
  try {
    return await db.getAllAsync(
      `SELECT route_id, name, date FROM routes ORDER BY date DESC;`
    );
  } catch (err) {
    console.error('getAllRoutes error:', err);
    return [];
  }
};

// Restituisce un percorso completo (path + waypoints)
export const getRouteById = async (route_id: string) => {
  if (!db) throw new Error('DB not initialized');
  try {
    const route = await db.getFirstAsync(
      `SELECT * FROM routes WHERE route_id = ?;`,
      [route_id]
    ) as Route;

    const waypoints = await db.getAllAsync(
      `SELECT * FROM waypoints WHERE route_id = ?;`,
      [route_id]
    ) as Waypoint[];

    return {
      ...route,
      path: JSON.parse(route.path) as Coordinate[],
      waypoints,
    };
  } catch (err) {
    console.error('getRouteById error:', err);
    return null;
  }
};

// Elimina un percorso e i suoi waypoints
export const deleteRoute = async (route_id: string) => {
  if (!db) throw new Error('DB not initialized');
  try {
    await db.withTransactionAsync(async () => {
      await db!.runAsync(`DELETE FROM waypoints WHERE route_id = ?;`, [route_id]);
      await db!.runAsync(`DELETE FROM routes WHERE route_id = ?;`, [route_id]);
    });
    console.log('Route deleted');
  } catch (err) {
    console.error('Delete route error:', err);
    throw err;
  }
};

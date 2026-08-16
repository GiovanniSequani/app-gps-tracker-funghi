import { XMLParser } from 'fast-xml-parser';
import { gunzipSync, strFromU8 } from 'fflate';
import {
  AccountArchiveError,
  type GpxCoordinate,
  type GpxMarker,
  type GpxTrackPoint,
  type GpxTrackSegment,
  type ParsedGpxRoute,
} from './types';
import { safeGpxName } from './validation';

type UnknownRecord = Record<string, unknown>;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
});

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function array(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function text(value: unknown): string | null {
  if (typeof value === 'string' || typeof value === 'number') {
    const normalized = String(value).trim();
    return normalized || null;
  }
  const item = record(value);
  return item ? text(item['#text']) : null;
}

function timestamp(value: unknown): number | null {
  const raw = text(value);
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function coordinate(value: unknown): GpxCoordinate | null {
  const item = record(value);
  if (!item) return null;
  const latitude = Number(item.lat);
  const longitude = Number(item.lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)
    || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  return { latitude, longitude, timestamp: timestamp(item.time) };
}

function species(value: string): 'Porcino' | 'Finferlo' | null {
  const normalized = value.toLowerCase();
  if (normalized.includes('porcin')) return 'Porcino';
  if (normalized.includes('finferl') || normalized.includes('gallinacci')) return 'Finferlo';
  return null;
}

function marker(value: unknown, index: number): GpxMarker | null {
  const item = record(value);
  const point = coordinate(value);
  if (!item || !point) return null;
  const name = text(item.name) ?? `Punto_${index + 1}`;
  const typeText = text(item.type) ?? name;
  const recognized = species(`${typeText} ${name}`);
  return { ...point, name, tipo: recognized ?? typeText };
}

function isGzip(bytes: Uint8Array, filename: string): boolean {
  return /\.gz$/i.test(filename) || (bytes[0] === 0x1f && bytes[1] === 0x8b);
}

function declaredGzipSize(bytes: Uint8Array): number | null {
  if (bytes.byteLength < 4) return null;
  const offset = bytes.byteLength - 4;
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true);
}

export function decodeGpxBytes(
  bytes: Uint8Array,
  filename: string,
  maxUncompressedBytes: number,
): Uint8Array {
  if (bytes.byteLength === 0) throw new AccountArchiveError('unknown', 'Il file GPX è vuoto.');
  if (!isGzip(bytes, filename)) {
    if (bytes.byteLength > maxUncompressedBytes) {
      throw new AccountArchiveError('size_exceeded', 'Il GPX supera il limite non compresso configurato.');
    }
    return bytes;
  }
  const declaredSize = declaredGzipSize(bytes);
  if (declaredSize !== null && declaredSize > maxUncompressedBytes) {
    throw new AccountArchiveError('size_exceeded', 'Il GPX compresso supera il limite non compresso configurato.');
  }
  try {
    const raw = gunzipSync(bytes);
    if (raw.byteLength > maxUncompressedBytes) {
      throw new AccountArchiveError('size_exceeded', 'Il GPX compresso supera il limite non compresso configurato.');
    }
    return raw;
  } catch (error) {
    if (error instanceof AccountArchiveError) throw error;
    throw new AccountArchiveError('unknown', 'Il file .gpx.gz non è valido.', { cause: error });
  }
}

export function parseGpxBytes(
  bytes: Uint8Array,
  filename: string,
  maxUncompressedBytes: number,
): ParsedGpxRoute {
  const raw = decodeGpxBytes(bytes, filename, maxUncompressedBytes);
  let parsed: UnknownRecord;
  try {
    parsed = parser.parse(strFromU8(raw)) as UnknownRecord;
  } catch (error) {
    throw new AccountArchiveError('unknown', 'Il contenuto GPX non è valido.', { cause: error });
  }
  const gpx = record(parsed.gpx);
  if (!gpx) throw new AccountArchiveError('unknown', 'Il file non contiene un documento GPX.');

  const tracks = array(gpx.trk).map(record).filter((value): value is UnknownRecord => value !== null);
  const routes = array(gpx.rte).map(record).filter((value): value is UnknownRecord => value !== null);
  let rawTrackPointCount = 0;
  const trackSegments: GpxTrackSegment[] = [];
  for (const track of tracks) {
    for (const segmentValue of array(track.trkseg)) {
      const segmentRecord = record(segmentValue);
      const rawPoints = array(segmentRecord?.trkpt);
      const startPointIndex = rawTrackPointCount;
      const points = rawPoints.flatMap((value) => {
        const pointIndex = rawTrackPointCount++;
        const point = coordinate(value);
        return point ? [{ ...point, pointIndex } satisfies GpxTrackPoint] : [];
      });
      if (rawPoints.length > 0) {
        trackSegments.push({
          startPointIndex,
          endPointIndex: rawTrackPointCount - 1,
          points,
        });
      }
    }
  }
  const trackPoints = trackSegments.flatMap((segment) => segment.points);
  const routePoints = routes.flatMap((route) => array(route.rtept));
  const parsedRoutePoints = routePoints
    .map(coordinate)
    .filter((value): value is GpxCoordinate => value !== null);
  const path = trackPoints.length > 0 ? trackPoints : parsedRoutePoints;
  if (path.length === 0) throw new AccountArchiveError('unknown', 'Il GPX non contiene punti di traccia validi.');

  if (trackSegments.length === 0 && parsedRoutePoints.length > 0) {
    rawTrackPointCount = parsedRoutePoints.length;
    const points = parsedRoutePoints.map((point, pointIndex) => ({ ...point, pointIndex }));
    trackSegments.push({ startPointIndex: 0, endPointIndex: points.length - 1, points });
  }

  const markers = array(gpx.wpt)
    .map(marker)
    .filter((value): value is GpxMarker => value !== null);
  const metadata = record(gpx.metadata);
  const name = text(tracks[0]?.name) ?? text(routes[0]?.name) ?? text(metadata?.name) ?? safeGpxName(filename);
  const times = path.map((point) => point.timestamp).filter((value): value is number => typeof value === 'number');
  const startedAt = times.length > 0 ? new Date(Math.min(...times)).toISOString() : null;
  return {
    name,
    path,
    markers,
    startedAt,
    porciniCount: markers.filter((item) => species(`${item.tipo} ${item.name}`) === 'Porcino').length,
    finferliCount: markers.filter((item) => species(`${item.tipo} ${item.name}`) === 'Finferlo').length,
    trackPoints: trackSegments.flatMap((segment) => segment.points),
    trackSegments,
    rawTrackPointCount,
  };
}

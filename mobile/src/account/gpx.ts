import * as Crypto from 'expo-crypto';
import { gzipSync, strToU8 } from 'fflate';
import type { ArchiveConfig, GpxCoordinate, GpxMarker, PreparedGpxUpload } from './types';
import { AccountArchiveError } from './types';

const EARTH_RADIUS_M = 6_371_000;

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function validCoordinate(point: GpxCoordinate): boolean {
  return Number.isFinite(point.latitude)
    && Number.isFinite(point.longitude)
    && point.latitude >= -90
    && point.latitude <= 90
    && point.longitude >= -180
    && point.longitude <= 180;
}

function timeElement(timestamp?: number | null): string {
  if (!timestamp || !Number.isFinite(timestamp)) return '';
  const date = new Date(timestamp);
  return Number.isNaN(date.valueOf()) ? '' : `<time>${date.toISOString()}</time>`;
}

export function buildGpxXml(name: string, points: GpxCoordinate[], markers: GpxMarker[]): string {
  const safePoints = points.filter(validCoordinate);
  const safeMarkers = markers.filter(validCoordinate);
  const trackPoints = safePoints
    .map((point) => `<trkpt lat="${point.latitude}" lon="${point.longitude}">${timeElement(point.timestamp)}</trkpt>`)
    .join('\n');
  const waypoints = safeMarkers
    .map((marker) => (
      `<wpt lat="${marker.latitude}" lon="${marker.longitude}">${timeElement(marker.timestamp)}`
      + `<name>${escapeXml(marker.name)}</name><type>${escapeXml(marker.tipo)}</type></wpt>`
    ))
    .join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="FunghiTracker" xmlns="http://www.topografix.com/GPX/1/1">',
    `<trk><name>${escapeXml(name)}</name><trkseg>`,
    trackPoints,
    '</trkseg></trk>',
    waypoints,
    '</gpx>',
  ].join('\n');
}

function toRadians(value: number): number {
  return value * Math.PI / 180;
}

export function calculateDistanceM(points: GpxCoordinate[]): number {
  const valid = points.filter(validCoordinate);
  let total = 0;
  for (let index = 1; index < valid.length; index += 1) {
    const previous = valid[index - 1];
    const current = valid[index];
    const dLat = toRadians(current.latitude - previous.latitude);
    const dLon = toRadians(current.longitude - previous.longitude);
    const lat1 = toRadians(previous.latitude);
    const lat2 = toRadians(current.latitude);
    const a = Math.sin(dLat / 2) ** 2
      + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    total += EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  return total;
}

export function calculateBbox(points: GpxCoordinate[]): PreparedGpxUpload['bbox'] {
  const valid = points.filter(validCoordinate);
  if (valid.length === 0) return null;
  return valid.reduce((bbox, point) => ({
    west: Math.min(bbox.west, point.longitude),
    south: Math.min(bbox.south, point.latitude),
    east: Math.max(bbox.east, point.longitude),
    north: Math.max(bbox.north, point.latitude),
  }), {
    west: valid[0].longitude,
    south: valid[0].latitude,
    east: valid[0].longitude,
    north: valid[0].latitude,
  });
}

function timestampIso(points: GpxCoordinate[], first: boolean): string | null {
  const timestamps = points
    .map((point) => point.timestamp)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (timestamps.length === 0) return null;
  const value = first ? Math.min(...timestamps) : Math.max(...timestamps);
  return new Date(value).toISOString();
}

function bufferToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Expo Crypto on Android bridges typed arrays to a Kotlin byte array. Passing
  // the backing ArrayBuffer type-checks, but fails at runtime in the Kotlin
  // converter with "Cannot convert '[object ArrayBuffer]'".
  const nativeBytes = new Uint8Array(bytes.byteLength);
  nativeBytes.set(bytes);
  const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, nativeBytes);
  return bufferToHex(digest);
}

export async function prepareGpxUpload(
  name: string,
  points: GpxCoordinate[],
  markers: GpxMarker[],
  config: ArchiveConfig,
): Promise<PreparedGpxUpload> {
  const validPoints = points.filter(validCoordinate);
  if (validPoints.length === 0) {
    throw new AccountArchiveError('unknown', 'La traccia non contiene punti GPS validi.');
  }
  const raw = strToU8(buildGpxXml(name, validPoints, markers));
  if (raw.byteLength > config.max_uncompressed_bytes) {
    throw new AccountArchiveError('size_exceeded', 'Il GPX non compresso supera il limite attualmente configurato.');
  }
  const bytes = gzipSync(raw, { level: 6 });
  if (bytes.byteLength > config.max_compressed_bytes) {
    throw new AccountArchiveError('size_exceeded', 'Il file compresso supera il limite attualmente configurato.');
  }
  return {
    bytes,
    compressedSizeBytes: bytes.byteLength,
    contentSha256: await sha256Hex(bytes),
    uncompressedSizeBytes: raw.byteLength,
    startedAt: timestampIso(validPoints, true),
    endedAt: timestampIso(validPoints, false),
    pointCount: validPoints.length,
    distanceM: calculateDistanceM(validPoints),
    bbox: calculateBbox(validPoints),
  };
}

export function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

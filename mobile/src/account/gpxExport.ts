import { strToU8 } from 'fflate';
import { effectiveTrim, trimTrackSegments } from './trackEdits';
import { AccountArchiveError } from './types';
import type { GpxCoordinate, GpxMushroomMarker, GpxTrack, ParsedGpxRoute } from './types';
import { safeGpxName } from './validation';

const GPX_NAMESPACE = 'http://www.topografix.com/GPX/1/1';
const FUNGHITRACKER_NAMESPACE = 'https://funghitracker.it/gpx/1';

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;',
  })[character] ?? character);
}

function coordinate(value: number): string {
  if (!Number.isFinite(value)) {
    throw new AccountArchiveError('unknown', 'La traccia contiene coordinate non valide.');
  }
  return String(value);
}

function timeElement(point: GpxCoordinate): string {
  if (!point.timestamp || !Number.isFinite(point.timestamp)) return '';
  const date = new Date(point.timestamp);
  return Number.isNaN(date.valueOf()) ? '' : `<time>${date.toISOString()}</time>`;
}

function historicalMarkerXml(marker: ParsedGpxRoute['markers'][number]): string[] {
  return [
    `  <wpt lat="${coordinate(marker.latitude)}" lon="${coordinate(marker.longitude)}">`,
    `    ${timeElement(marker)}`,
    `    <name>${escapeXml(marker.name)}</name>`,
    `    <type>${escapeXml(marker.tipo)}</type>`,
    '  </wpt>',
  ];
}

function editorMarkerXml(marker: GpxMushroomMarker, name: string): string[] {
  const singular = marker.species === 'porcini' ? 'porcino' : 'finferlo';
  return [
    `  <wpt lat="${coordinate(marker.latitude)}" lon="${coordinate(marker.longitude)}">`,
    `    <name>${name}</name>`,
    `    <type>${singular}</type>`,
    `    <desc>${singular === 'porcino' ? 'Porcini' : 'Finferli'}: ${marker.count}</desc>`,
    '    <extensions>',
    `      <funghitracker:species>${marker.species}</funghitracker:species>`,
    `      <funghitracker:count>${marker.count}</funghitracker:count>`,
    '    </extensions>',
    '  </wpt>',
  ];
}

/** Crea una copia locale derivata senza modificare il GPX raw in Storage. */
export function createDerivedGpxExport(
  track: GpxTrack,
  parsed: ParsedGpxRoute,
  markers: GpxMushroomMarker[],
): { bytes: Uint8Array; filename: string } {
  const trim = effectiveTrim(
    parsed.rawTrackPointCount,
    track.trim_start_point_index,
    track.trim_end_point_index,
  );
  const keptSegments = trimTrackSegments(parsed.trackSegments, trim.start, trim.end);
  const keptPointCount = keptSegments.reduce((total, segment) => total + segment.length, 0);
  if (keptPointCount < 2) {
    throw new AccountArchiveError('unknown', 'Il taglio salvato deve mantenere almeno due punti validi.');
  }

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<gpx version="1.1" creator="FunghiTracker" xmlns="${GPX_NAMESPACE}" xmlns:funghitracker="${FUNGHITRACKER_NAMESPACE}">`,
  ];

  // I waypoint contenuti nel GPX raw sono dati storici: nome, tipo e ordine
  // restano invariati anche quando il percorso e' stato accorciato.
  for (const marker of parsed.markers) lines.push(...historicalMarkerXml(marker));

  const pointByIndex = new Map(parsed.trackPoints.map((point) => [point.pointIndex, point]));
  const visibleMarkers = markers
    .filter((marker) => marker.track_point_index >= trim.start && marker.track_point_index <= trim.end)
    .filter((marker) => pointByIndex.has(marker.track_point_index))
    .sort((left, right) => (
      left.track_point_index - right.track_point_index || left.species.localeCompare(right.species)
    ));
  let porciniIndex = 0;
  let finferliIndex = 0;
  for (const marker of visibleMarkers) {
    const name = marker.species === 'porcini'
      ? `porcino${++porciniIndex}`
      : `finferlo${++finferliIndex}`;
    const point = pointByIndex.get(marker.track_point_index)!;
    lines.push(...editorMarkerXml({ ...marker, latitude: point.latitude, longitude: point.longitude }, name));
  }

  if (parsed.usesTrackPoints) {
    lines.push('  <trk>', `    <name>${escapeXml(track.display_name)}</name>`);
    for (const segment of keptSegments) {
      lines.push('    <trkseg>');
      for (const point of segment) {
        lines.push(
          `      <trkpt lat="${coordinate(point.latitude)}" lon="${coordinate(point.longitude)}">${timeElement(point)}</trkpt>`,
        );
      }
      lines.push('    </trkseg>');
    }
    lines.push('  </trk>');
  } else {
    lines.push('  <rte>', `    <name>${escapeXml(track.display_name)}</name>`);
    for (const segment of keptSegments) {
      for (const point of segment) {
        lines.push(
          `    <rtept lat="${coordinate(point.latitude)}" lon="${coordinate(point.longitude)}">${timeElement(point)}</rtept>`,
        );
      }
    }
    lines.push('  </rte>');
  }

  lines.push('</gpx>', '');
  return {
    bytes: strToU8(lines.join('\n')),
    filename: `${safeGpxName(track.display_name)}.gpx`,
  };
}

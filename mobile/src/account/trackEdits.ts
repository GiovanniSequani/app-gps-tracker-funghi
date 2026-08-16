import type {
  ArchiveMapRoute,
  GpxCoordinate,
  GpxMushroomMarker,
  GpxTrackPoint,
  GpxTrackSegment,
  MushroomSpecies,
} from './types';

export type EffectiveTrim = { start: number; end: number };

export function effectiveTrim(
  pointCount: number,
  trimStartPointIndex: number | null,
  trimEndPointIndex: number | null,
): EffectiveTrim {
  if (!Number.isInteger(pointCount) || pointCount < 2) {
    throw new Error('La traccia deve contenere almeno due punti.');
  }
  const start = trimStartPointIndex ?? 0;
  const end = trimEndPointIndex ?? pointCount - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end >= pointCount || end <= start) {
    throw new Error('Il taglio deve mantenere almeno due punti della traccia.');
  }
  return { start, end };
}

export function persistedTrim(pointCount: number, start: number, end: number): {
  trimStartPointIndex: number | null;
  trimEndPointIndex: number | null;
} {
  effectiveTrim(pointCount, start, end);
  return start === 0 && end === pointCount - 1
    ? { trimStartPointIndex: null, trimEndPointIndex: null }
    : { trimStartPointIndex: start, trimEndPointIndex: end };
}

export function trimTrackSegments(
  segments: GpxTrackSegment[],
  start: number,
  end: number,
): GpxTrackPoint[][] {
  return segments
    .map((segment) => segment.points.filter((point) => point.pointIndex >= start && point.pointIndex <= end))
    .filter((segment) => segment.length > 0);
}

export function excludedTrackSegments(
  segments: GpxTrackSegment[],
  start: number,
  end: number,
): GpxTrackPoint[][] {
  return segments.flatMap((segment) => {
    const before = segment.points.filter((point) => point.pointIndex < start);
    const after = segment.points.filter((point) => point.pointIndex > end);
    return [before, after].filter((part) => part.length > 0);
  });
}

export function visibleMushroomMarkers(
  markers: GpxMushroomMarker[],
  start: number,
  end: number,
): GpxMushroomMarker[] {
  return markers.filter((marker) => marker.track_point_index >= start && marker.track_point_index <= end);
}

export function snapMarkersToTrack(
  markers: GpxMushroomMarker[],
  points: GpxTrackPoint[],
): GpxMushroomMarker[] {
  const pointByIndex = new Map(points.map((point) => [point.pointIndex, point]));
  return markers.flatMap((marker) => {
    const point = pointByIndex.get(marker.track_point_index);
    return point ? [{ ...marker, latitude: point.latitude, longitude: point.longitude }] : [];
  });
}

export function planMushroomMarkerChanges(
  original: GpxMushroomMarker[],
  draft: GpxMushroomMarker[],
): {
  deleteMarkers: Array<{ trackPointIndex: number; species: MushroomSpecies }>;
  saveMarkers: GpxMushroomMarker[];
} {
  const markerKey = (marker: Pick<GpxMushroomMarker, 'track_point_index' | 'species'>) => (
    `${marker.track_point_index}:${marker.species}`
  );
  const originalByKey = new Map(original.map((marker) => [markerKey(marker), marker]));
  const draftByKey = new Map(draft.map((marker) => [markerKey(marker), marker]));
  return {
    deleteMarkers: original
      .filter((marker) => !draftByKey.has(markerKey(marker)))
      .map((marker) => ({ trackPointIndex: marker.track_point_index, species: marker.species })),
    saveMarkers: draft.filter((marker) => {
      const previous = originalByKey.get(markerKey(marker));
      return !previous
        || previous.count !== marker.count
        || previous.latitude !== marker.latitude
        || previous.longitude !== marker.longitude;
    }),
  };
}

export function nearestTrackPoint(
  points: GpxTrackPoint[],
  coordinate: { latitude: number; longitude: number },
  start: number,
  end: number,
): GpxTrackPoint | null {
  let nearest: GpxTrackPoint | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  const latitudeScale = Math.cos((coordinate.latitude * Math.PI) / 180);
  for (const point of points) {
    if (point.pointIndex < start || point.pointIndex > end) continue;
    const deltaLatitude = point.latitude - coordinate.latitude;
    const deltaLongitude = (point.longitude - coordinate.longitude) * latitudeScale;
    const distance = deltaLatitude * deltaLatitude + deltaLongitude * deltaLongitude;
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = point;
    }
  }
  return nearest;
}

export function applyCloudTrackEdit(
  route: ArchiveMapRoute,
  start: number,
  end: number,
  mushroomMarkers: GpxMushroomMarker[],
): ArchiveMapRoute {
  if (!route.cloudEdit) return route;
  const trim = persistedTrim(route.cloudEdit.rawPointCount, start, end);
  const pathSegments = trimTrackSegments(route.cloudEdit.segments, start, end);
  const path = pathSegments.flat() as GpxCoordinate[];
  return {
    ...route,
    path,
    pathSegments,
    cloudEdit: {
      ...route.cloudEdit,
      trimStartPointIndex: trim.trimStartPointIndex,
      trimEndPointIndex: trim.trimEndPointIndex,
      mushroomMarkers: snapMarkersToTrack(mushroomMarkers, route.cloudEdit.rawPoints),
    },
  };
}

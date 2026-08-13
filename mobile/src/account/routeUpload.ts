import { getArchiveConfig, uploadPreparedTrack } from './client';
import { calculateDistanceM, prepareGpxUpload } from './gpx';
import type { ArchiveConfig, ArchiveMapRoute, GpxCoordinate, GpxMarker, GpxTrack } from './types';

export function routeSummary(input: {
  routeId: string;
  name: string;
  date: string;
  path: GpxCoordinate[];
  markers: GpxMarker[];
}): ArchiveMapRoute {
  return {
    ...input,
    distanceM: calculateDistanceM(input.path),
    pointCount: input.path.length,
    porciniCount: input.markers.filter((marker) => marker.tipo.toLowerCase().includes('porcin')).length,
    finferliCount: input.markers.filter((marker) => marker.tipo.toLowerCase().includes('finferl')).length,
  };
}

export async function uploadRouteToCloud(
  route: { name: string; path: GpxCoordinate[]; markers: GpxMarker[] },
  config?: ArchiveConfig,
): Promise<GpxTrack> {
  const archiveConfig = config ?? await getArchiveConfig();
  const prepared = await prepareGpxUpload(route.name, route.path, route.markers, archiveConfig);
  return uploadPreparedTrack({ displayName: route.name, prepared });
}

import type { GpxCoordinate, GpxMarker, GpxTrack } from './types';

export type RecordedRoute = {
  routeId: string;
  name: string;
  date: string;
  path: GpxCoordinate[];
  markers: GpxMarker[];
};

export type RecordingSaveResult = {
  location: 'cloud' | 'local' | 'shared';
  track?: GpxTrack;
  cloudError?: unknown;
};

export async function saveRecordingCloudFirst(
  route: RecordedRoute,
  access: { cloudAllowed: boolean; localAllowed: boolean },
  dependencies: {
    upload: (route: Pick<RecordedRoute, 'name' | 'path' | 'markers'>) => Promise<GpxTrack>;
    saveLocal: (route: RecordedRoute) => Promise<void>;
    shareGuest: (route: RecordedRoute) => Promise<void>;
  },
): Promise<RecordingSaveResult> {
  let cloudError: unknown;
  if (access.cloudAllowed) {
    try {
      const track = await dependencies.upload(route);
      return { location: 'cloud', track };
    } catch (error) {
      cloudError = error;
    }
  }

  if (!access.localAllowed) {
    await dependencies.shareGuest(route);
    return { location: 'shared' };
  }
  await dependencies.saveLocal(route);
  return { location: 'local', cloudError };
}

import type { GpxTrack } from './types';

type CloudTrackDates = Pick<GpxTrack, 'started_at' | 'ready_at' | 'created_at'>;

export function getCloudTrackDate(track: CloudTrackDates): string {
  return track.started_at ?? track.ready_at ?? track.created_at;
}

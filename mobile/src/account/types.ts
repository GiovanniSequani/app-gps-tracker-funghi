import type { Session } from '@supabase/supabase-js';

export type ArchiveConfig = {
  singleton_id: 1;
  max_tracks_per_user: number;
  max_compressed_bytes: number;
  max_uncompressed_bytes: number;
  terms_version: string;
  privacy_version: string;
  research_consent_version: string;
  updated_at: string;
};

export type UserProfile = {
  user_id: string;
  username: string;
  terms_version: string;
  privacy_version: string;
  raw_gpx_research_consent: boolean;
  raw_gpx_research_consent_version: string;
};

export type GpxTrack = {
  id: string;
  storage_path: string;
  status: 'ready';
  display_name: string;
  original_filename: string;
  compressed_size_bytes: number;
  uncompressed_size_bytes: number | null;
  started_at: string | null;
  ended_at: string | null;
  point_count: number | null;
  distance_m: number | null;
  ready_at: string | null;
  created_at: string;
  trim_start_point_index: number | null;
  trim_end_point_index: number | null;
};

export type ArchiveData = {
  config: ArchiveConfig;
  profile: UserProfile;
  tracks: GpxTrack[];
};

export type AccountSessionState = {
  session: Session | null;
  username: string | null;
  loading: boolean;
  error: string | null;
};

export type GpxCoordinate = {
  latitude: number;
  longitude: number;
  timestamp?: number | null;
};

export type GpxTrackPoint = GpxCoordinate & {
  pointIndex: number;
};

export type GpxTrackSegment = {
  startPointIndex: number;
  endPointIndex: number;
  points: GpxTrackPoint[];
};

export type MushroomSpecies = 'porcini' | 'finferli';

export type GpxMushroomMarker = {
  id: string;
  track_id: string;
  track_point_index: number;
  latitude: number;
  longitude: number;
  species: MushroomSpecies;
  count: number;
  created_at: string;
  updated_at: string;
};

export type GpxMarker = GpxCoordinate & {
  name: string;
  tipo: string;
};

export type ParsedGpxRoute = {
  name: string;
  path: GpxCoordinate[];
  markers: GpxMarker[];
  startedAt: string | null;
  porciniCount: number;
  finferliCount: number;
  trackPoints: GpxTrackPoint[];
  trackSegments: GpxTrackSegment[];
  rawTrackPointCount: number;
};

export type CloudTrackEditData = {
  rawPointCount: number;
  rawPoints: GpxTrackPoint[];
  segments: GpxTrackSegment[];
  trimStartPointIndex: number | null;
  trimEndPointIndex: number | null;
  mushroomMarkers: GpxMushroomMarker[];
};

export type ArchiveMapRoute = {
  routeId: string;
  name: string;
  date: string;
  path: GpxCoordinate[];
  markers: GpxMarker[];
  distanceM: number;
  pointCount: number;
  porciniCount: number;
  finferliCount: number;
  pathSegments?: GpxCoordinate[][];
  cloudEdit?: CloudTrackEditData;
};

export type PreparedGpxUpload = {
  bytes: Uint8Array;
  compressedSizeBytes: number;
  contentSha256: string;
  uncompressedSizeBytes: number;
  startedAt: string | null;
  endedAt: string | null;
  pointCount: number;
  distanceM: number;
  bbox: { west: number; south: number; east: number; north: number } | null;
};

export type ReserveTrackResult = {
  id: string;
  storage_path: string;
  status: 'pending_upload';
  max_tracks_per_user: number;
  remaining_slots: number;
};

export type AccountErrorCode =
  | 'duplicate_username'
  | 'invalid_credentials'
  | 'email_not_confirmed'
  | 'weak_password'
  | 'quota_exceeded'
  | 'size_exceeded'
  | 'session_expired'
  | 'upload_failed'
  | 'finalize_failed'
  | 'partial_delete'
  | 'invalid_track_name'
  | 'track_not_found'
  | 'invalid_track_edit'
  | 'network'
  | 'configuration'
  | 'unknown';

export class AccountArchiveError extends Error {
  readonly code: AccountErrorCode;
  readonly partial: boolean;

  constructor(code: AccountErrorCode, message: string, options?: { cause?: unknown; partial?: boolean }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AccountArchiveError';
    this.code = code;
    this.partial = options?.partial ?? false;
  }
}

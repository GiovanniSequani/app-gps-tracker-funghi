import { AccountArchiveError, type ArchiveConfig } from './types';

export type PickedGpxAsset = {
  name: string;
  mimeType?: string | null;
  size?: number | null;
  uri: string;
};

type ImportReadDependencies = {
  stage: (asset: PickedGpxAsset) => Promise<string>;
  statSize: (stagedUri: string) => Promise<number | null>;
  readBytes: (stagedUri: string) => Promise<Uint8Array>;
  cleanup: (stagedUri: string) => Promise<void>;
};

function isCompressedAsset(asset: PickedGpxAsset): boolean {
  const mimeType = asset.mimeType?.toLowerCase() ?? '';
  return /\.gpx\.gz$/i.test(asset.name)
    || mimeType === 'application/gzip'
    || mimeType === 'application/x-gzip';
}

export function gpxImportByteLimit(asset: PickedGpxAsset, config: ArchiveConfig): number {
  return isCompressedAsset(asset) ? config.max_compressed_bytes : config.max_uncompressed_bytes;
}

export function assertSafeGpxImportSize(
  asset: PickedGpxAsset,
  config: ArchiveConfig,
  size = asset.size,
): number {
  if (!Number.isSafeInteger(size) || (size as number) <= 0) {
    throw new AccountArchiveError(
      'size_exceeded',
      'Impossibile verificare in modo sicuro la dimensione del file GPX.',
    );
  }
  const limit = gpxImportByteLimit(asset, config);
  if ((size as number) > limit) {
    throw new AccountArchiveError('size_exceeded', 'Il file GPX supera il limite configurato.');
  }
  return size as number;
}

export async function readPickedGpxSafely(
  asset: PickedGpxAsset,
  config: ArchiveConfig,
  dependencies: ImportReadDependencies,
): Promise<Uint8Array> {
  const declaredSize = assertSafeGpxImportSize(asset, config);
  let stagedUri: string | null = null;
  try {
    stagedUri = await dependencies.stage(asset);
    const stagedSize = await dependencies.statSize(stagedUri);
    assertSafeGpxImportSize(asset, config, stagedSize);
    if (stagedSize !== declaredSize) {
      throw new AccountArchiveError('size_exceeded', 'La dimensione del file GPX e\' cambiata durante l\'importazione.');
    }
    const bytes = await dependencies.readBytes(stagedUri);
    if (bytes.byteLength !== stagedSize) {
      throw new AccountArchiveError('size_exceeded', 'La lettura del file GPX non corrisponde alla dimensione verificata.');
    }
    return bytes;
  } finally {
    if (stagedUri) await dependencies.cleanup(stagedUri).catch(() => undefined);
  }
}

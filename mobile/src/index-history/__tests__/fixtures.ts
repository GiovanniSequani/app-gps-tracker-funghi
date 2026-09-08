import type {
  IndexHistoryCurrent,
  IndexHistoryManifest,
} from '../types';

export const dates = ['2026-08-23', '2026-08-24', '2026-08-25'];

export function historyCurrent(version = 'v1'): IndexHistoryCurrent {
  return {
    contract_version: 1,
    version,
    index_date: dates[2],
    date_from: dates[0],
    date_to: dates[2],
    day_count: dates.length,
    manifest_path: `${version}/manifest.json`,
    dataset_sha256: `dataset-${version}`,
  };
}

export function historyManifest(version = 'v1', compressedLength = 1): IndexHistoryManifest {
  return {
    contract_version: 1,
    version,
    index_date: dates[2],
    dates: [...dates],
    day_count: dates.length,
    available_dates: [dates[0], dates[2]],
    missing_dates: [dates[1]],
    dataset_sha256: `dataset-${version}`,
    crs: 'EPSG:4326',
    rows: 1,
    cols: 1,
    step_deg: 0.003,
    origin_lat: 46,
    origin_lon: 11,
    bbox: { west: 10.9985, south: 45.9985, east: 11.0015, north: 46.0015 },
    latitude_order: 'ascending_south_to_north',
    longitude_order: 'ascending_west_to_east',
    chunk_size: { rows: 50, cols: 50 },
    compression: { codec: 'zlib' },
    binary_layout: {
      layout: 'row-major interleaved cells',
      endianness: 'little',
      bytes_per_cell_uncompressed: dates.length * 4 * 2,
      fields: [
        {
          name: 'porcini_score',
          dtype: 'float32',
          shape: [dates.length],
          date_axis: 'dates',
          unit: 'score_0_100',
          nodata: 'NaN',
          offset_bytes: 0,
        },
        {
          name: 'finferli_score',
          dtype: 'float32',
          shape: [dates.length],
          date_axis: 'dates',
          unit: 'score_0_100',
          nodata: 'NaN',
          offset_bytes: dates.length * 4,
        },
      ],
    },
    chunks: [{
      row: 0,
      col: 0,
      row_offset: 0,
      col_offset: 0,
      rows: 1,
      cols: 1,
      path: `${version}/chunks/r00_c00.bin.zlib`,
      byte_length: compressedLength,
      raw_byte_length: dates.length * 4 * 2,
    }],
  };
}

export function historyRawCell(porcini = [10.5, Number.NaN, 75.25]): ArrayBuffer {
  const buffer = new ArrayBuffer(dates.length * 4 * 2);
  const view = new DataView(buffer);
  porcini.forEach((value, index) => view.setFloat32(index * 4, value, true));
  [20.25, Number.NaN, 52.5].forEach((value, index) => (
    view.setFloat32(dates.length * 4 + index * 4, value, true)
  ));
  return buffer;
}

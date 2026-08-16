import { gzipSync, strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { decodeGpxBytes, parseGpxBytes } from '../gpxParser';

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>Bosco importato</name><trkseg>
    <trkpt lat="45.1" lon="10.2"><time>2026-08-08T08:00:00Z</time></trkpt>
    <trkpt lat="45.2" lon="10.3"><time>2026-08-08T08:05:00Z</time></trkpt>
  </trkseg></trk>
  <wpt lat="45.15" lon="10.25"><name>Porcino_1</name><type>Porcino</type></wpt>
  <wpt lat="45.16" lon="10.26"><name>Gallinaccio</name></wpt>
</gpx>`;

describe('GPX import parser', () => {
  it('legge una traccia GPX e riconosce i ritrovamenti', () => {
    const parsed = parseGpxBytes(strToU8(xml), 'bosco.gpx', 100_000);
    expect(parsed.name).toBe('Bosco importato');
    expect(parsed.path).toHaveLength(2);
    expect(parsed.porciniCount).toBe(1);
    expect(parsed.finferliCount).toBe(1);
    expect(parsed.startedAt).toBe('2026-08-08T08:00:00.000Z');
  });

  it('decomprime .gpx.gz prima del parsing', () => {
    const compressed = gzipSync(strToU8(xml));
    expect(decodeGpxBytes(compressed, 'bosco.gpx.gz', 100_000)).toEqual(strToU8(xml));
    expect(parseGpxBytes(compressed, 'bosco.gpx.gz', 100_000).path).toHaveLength(2);
  });

  it('rifiuta un payload oltre il limite configurato', () => {
    expect(() => decodeGpxBytes(strToU8(xml), 'bosco.gpx', 10)).toThrow(/limite/);
  });

  it('mantiene ordine raw e confini dei segmenti per gli indici backend', () => {
    const segmented = `<gpx version="1.1"><trk><trkseg>
      <trkpt lat="45" lon="10"/><trkpt lat="999" lon="10"/>
    </trkseg><trkseg><trkpt lat="46" lon="11"/><trkpt lat="47" lon="12"/></trkseg></trk></gpx>`;
    const parsed = parseGpxBytes(strToU8(segmented), 'segmenti.gpx', 100_000);
    expect(parsed.rawTrackPointCount).toBe(4);
    expect(parsed.trackPoints.map((point) => point.pointIndex)).toEqual([0, 2, 3]);
    expect(parsed.trackSegments.map((segment) => [segment.startPointIndex, segment.endPointIndex]))
      .toEqual([[0, 1], [2, 3]]);
  });
});

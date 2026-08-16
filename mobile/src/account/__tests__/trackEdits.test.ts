import { describe, expect, it } from 'vitest';
import {
  applyCloudTrackEdit,
  effectiveTrim,
  excludedTrackSegments,
  nearestTrackPoint,
  planMushroomMarkerChanges,
  persistedTrim,
  snapMarkersToTrack,
  trimTrackSegments,
  visibleMushroomMarkers,
} from '../trackEdits';

const segments = [
  {
    startPointIndex: 0,
    endPointIndex: 2,
    points: [0, 1, 2].map((pointIndex) => ({ pointIndex, latitude: 45 + pointIndex * 0.01, longitude: 10 })),
  },
  {
    startPointIndex: 3,
    endPointIndex: 5,
    points: [3, 4, 5].map((pointIndex) => ({ pointIndex, latitude: 45 + pointIndex * 0.01, longitude: 10 })),
  },
];

describe('cloud track editing geometry', () => {
  it('normalizza il percorso completo a null/null e richiede due punti', () => {
    expect(persistedTrim(6, 0, 5)).toEqual({ trimStartPointIndex: null, trimEndPointIndex: null });
    expect(() => effectiveTrim(6, 3, 3)).toThrow(/almeno due punti/);
  });

  it('taglia in modo inclusivo senza collegare segmenti GPX distinti', () => {
    expect(trimTrackSegments(segments, 1, 4).map((part) => part.map((point) => point.pointIndex)))
      .toEqual([[1, 2], [3, 4]]);
    expect(excludedTrackSegments(segments, 1, 4).map((part) => part.map((point) => point.pointIndex)))
      .toEqual([[0], [5]]);
  });

  it('seleziona il vero point_index più vicino entro il trim', () => {
    const point = nearestTrackPoint(segments.flatMap((segment) => segment.points), {
      latitude: 45.031,
      longitude: 10,
    }, 1, 4);
    expect(point?.pointIndex).toBe(3);
  });

  it('nasconde fuori trim senza cancellare e riallinea le coordinate al GPX', () => {
    const markers = [
      { id: 'a', track_id: 't', track_point_index: 0, latitude: 0, longitude: 0, species: 'porcini' as const, count: 2, created_at: '', updated_at: '' },
      { id: 'b', track_id: 't', track_point_index: 3, latitude: 0, longitude: 0, species: 'finferli' as const, count: 5, created_at: '', updated_at: '' },
    ];
    const snapped = snapMarkersToTrack(markers, segments.flatMap((segment) => segment.points));
    expect(snapped[1]).toMatchObject({ track_point_index: 3, latitude: 45.03, longitude: 10, count: 5 });
    expect(visibleMushroomMarkers(snapped, 1, 4).map((marker) => marker.track_point_index)).toEqual([3]);
    expect(snapped).toHaveLength(2);
  });

  it('pianifica aggiunta, modifica e rimozione per coppia point_index e specie', () => {
    const original = [
      { id: 'a', track_id: 't', track_point_index: 1, latitude: 45.01, longitude: 10, species: 'porcini' as const, count: 1, created_at: '', updated_at: '' },
      { id: 'b', track_id: 't', track_point_index: 3, latitude: 45.03, longitude: 10, species: 'porcini' as const, count: 2, created_at: '', updated_at: '' },
      { id: 'c', track_id: 't', track_point_index: 3, latitude: 45.03, longitude: 10, species: 'finferli' as const, count: 6, created_at: '', updated_at: '' },
    ];
    const draft = [
      { ...original[1], count: 8 },
      original[2],
      { id: 'draft', track_id: 't', track_point_index: 4, latitude: 45.04, longitude: 10, species: 'finferli' as const, count: 5, created_at: '', updated_at: '' },
    ];
    const changes = planMushroomMarkerChanges(original, draft);
    expect(changes.deleteMarkers).toEqual([{ trackPointIndex: 1, species: 'porcini' }]);
    expect(changes.saveMarkers.map((marker) => [marker.track_point_index, marker.species, marker.count]))
      .toEqual([[3, 'porcini', 8], [4, 'finferli', 5]]);
  });

  it('ricostruisce la stessa geometria visibile quando trim e marker vengono riaperti', () => {
    const marker = { id: 'm', track_id: 'track', track_point_index: 3, latitude: 45.03, longitude: 10, species: 'porcini' as const, count: 4, created_at: '', updated_at: '' };
    const route = {
      routeId: 'track', name: 'Bosco', date: '', path: segments.flatMap((segment) => segment.points),
      pathSegments: segments.map((segment) => segment.points), markers: [], distanceM: 0, pointCount: 6,
      porciniCount: 0, finferliCount: 0,
      cloudEdit: {
        rawPointCount: 6,
        rawPoints: segments.flatMap((segment) => segment.points),
        segments,
        trimStartPointIndex: null,
        trimEndPointIndex: null,
        mushroomMarkers: [marker],
      },
    };
    const firstOpen = applyCloudTrackEdit(route, 1, 4, [marker]);
    const reopened = applyCloudTrackEdit(route, 1, 4, firstOpen.cloudEdit!.mushroomMarkers);
    expect(reopened.pathSegments?.map((part) => part.map((point: any) => point.pointIndex)))
      .toEqual([[1, 2], [3, 4]]);
    expect(reopened.cloudEdit?.mushroomMarkers).toEqual(firstOpen.cloudEdit?.mushroomMarkers);
  });
});

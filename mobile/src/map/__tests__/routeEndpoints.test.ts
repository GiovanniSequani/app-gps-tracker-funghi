import { describe, expect, it } from 'vitest';

import { buildRouteEndpointMarkers } from '../routeEndpoints';

describe('buildRouteEndpointMarkers', () => {
  it('adds start and end markers to saved routes', () => {
    const markers = buildRouteEndpointMarkers([
      {
        route_id: 'route-1',
        name: 'Bosco',
        path: [
          { latitude: 45.1, longitude: 9.1 },
          { latitude: 45.2, longitude: 9.2 },
        ],
      },
    ], [], false);

    expect(markers).toEqual([
      {
        id: 'route-1-start',
        kind: 'start',
        coordinate: [9.1, 45.1],
        accessibilityLabel: 'Inizio del percorso Bosco',
      },
      {
        id: 'route-1-end',
        kind: 'end',
        coordinate: [9.2, 45.2],
        accessibilityLabel: 'Fine del percorso Bosco',
      },
    ]);
  });

  it('shows only the starting marker for the recording in progress', () => {
    const markers = buildRouteEndpointMarkers([], [
      { latitude: 46, longitude: 10 },
      { latitude: 46.1, longitude: 10.1 },
    ], true);

    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({
      id: 'current-recording-start',
      kind: 'start',
      coordinate: [10, 46],
    });
  });

  it('ignores invalid coordinates and does not expose a current marker after recording stops', () => {
    const markers = buildRouteEndpointMarkers([
      {
        name: 'Importata',
        path: [
          { latitude: Number.NaN, longitude: 8 },
          { latitude: 44, longitude: 8.5 },
        ],
      },
    ], [{ latitude: 43, longitude: 8 }], false);

    expect(markers).toHaveLength(1);
    expect(markers[0].coordinate).toEqual([8.5, 44]);
    expect(markers.some((marker) => marker.id === 'current-recording-start')).toBe(false);
  });
});

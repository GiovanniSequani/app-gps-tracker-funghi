export type RouteCoordinate = {
  latitude: number;
  longitude: number;
};

export type EndpointRoute = {
  route_id?: string;
  name: string;
  path: RouteCoordinate[];
};

export type RouteEndpointMarker = {
  id: string;
  kind: 'start' | 'end';
  coordinate: [number, number];
  accessibilityLabel: string;
};

function isValidCoordinate(point: RouteCoordinate | undefined): point is RouteCoordinate {
  return Boolean(
    point
    && Number.isFinite(point.latitude)
    && Number.isFinite(point.longitude),
  );
}

export function buildRouteEndpointMarkers(
  routes: EndpointRoute[],
  currentPath: RouteCoordinate[],
  recording: boolean,
): RouteEndpointMarker[] {
  const markers: RouteEndpointMarker[] = [];

  routes.forEach((route, routeIndex) => {
    const validPath = route.path.filter(isValidCoordinate);
    if (validPath.length === 0) return;

    const routeKey = route.route_id ?? `${route.name}-${routeIndex}`;
    const first = validPath[0];
    markers.push({
      id: `${routeKey}-start`,
      kind: 'start',
      coordinate: [first.longitude, first.latitude],
      accessibilityLabel: `Inizio del percorso ${route.name}`,
    });

    if (validPath.length > 1) {
      const last = validPath[validPath.length - 1];
      markers.push({
        id: `${routeKey}-end`,
        kind: 'end',
        coordinate: [last.longitude, last.latitude],
        accessibilityLabel: `Fine del percorso ${route.name}`,
      });
    }
  });

  if (recording) {
    const firstCurrentPoint = currentPath.find(isValidCoordinate);
    if (firstCurrentPoint) {
      markers.push({
        id: 'current-recording-start',
        kind: 'start',
        coordinate: [firstCurrentPoint.longitude, firstCurrentPoint.latitude],
        accessibilityLabel: 'Inizio della registrazione in corso',
      });
    }
  }

  return markers;
}

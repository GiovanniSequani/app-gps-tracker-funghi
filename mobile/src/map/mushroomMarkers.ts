export type MushroomMapSpecies = 'porcini' | 'finferli';

export type MushroomMapMarker = {
  latitude: number;
  longitude: number;
  species: MushroomMapSpecies;
  count: number;
};

export type MushroomFeatureProperties = {
  species: MushroomMapSpecies | 'mixed';
  count: number;
  label: string;
  porciniCount: number;
  finferliCount: number;
};

export type MushroomMapFeature = GeoJSON.Feature<GeoJSON.Point, MushroomFeatureProperties>;

type GroupedMarker = Pick<MushroomMapMarker, 'latitude' | 'longitude'> & {
  porciniCount: number;
  finferliCount: number;
};

const MERCATOR_TILE_SIZE = 512;
const MAX_CLUSTER_ZOOM = 15;
const CLUSTER_RADIUS_PX = 44;

function validMarker(marker: MushroomMapMarker): boolean {
  return Number.isFinite(marker.latitude)
    && Number.isFinite(marker.longitude)
    && marker.latitude >= -90
    && marker.latitude <= 90
    && marker.longitude >= -180
    && marker.longitude <= 180
    && Number.isInteger(marker.count)
    && marker.count > 0;
}

export function mushroomMarkersToGeoJSON(
  markers: MushroomMapMarker[],
): GeoJSON.FeatureCollection<GeoJSON.Point, MushroomFeatureProperties> {
  const grouped = new Map<string, GroupedMarker>();
  for (const marker of markers) {
    if (!validMarker(marker)) continue;
    const key = `${marker.latitude.toFixed(7)}:${marker.longitude.toFixed(7)}`;
    const previous = grouped.get(key);
    const next = previous ?? {
      latitude: marker.latitude,
      longitude: marker.longitude,
      porciniCount: 0,
      finferliCount: 0,
    };
    next[marker.species === 'porcini' ? 'porciniCount' : 'finferliCount'] += marker.count;
    grouped.set(key, next);
  }

  return {
    type: 'FeatureCollection',
    features: [...grouped.entries()].map(([id, marker]) => {
      const count = marker.porciniCount + marker.finferliCount;
      const species = marker.porciniCount > 0 && marker.finferliCount > 0
        ? 'mixed' as const
        : marker.porciniCount > 0 ? 'porcini' as const : 'finferli' as const;
      const label = species === 'mixed'
        ? `P${marker.porciniCount} F${marker.finferliCount}`
        : `${species === 'porcini' ? 'P' : 'F'}${count > 1 ? count : ''}`;
      return {
        type: 'Feature' as const,
        id,
        geometry: {
          type: 'Point' as const,
          coordinates: [marker.longitude, marker.latitude],
        },
        properties: {
          species,
          count,
          label,
          porciniCount: marker.porciniCount,
          finferliCount: marker.finferliCount,
        },
      };
    }),
  };
}

function mercatorPixel(coordinates: GeoJSON.Position, zoom: number): [number, number] {
  const [longitude, rawLatitude] = coordinates;
  const latitude = Math.max(-85.05112878, Math.min(85.05112878, rawLatitude));
  const worldSize = MERCATOR_TILE_SIZE * (2 ** zoom);
  const sinLatitude = Math.sin(latitude * Math.PI / 180);
  return [
    ((longitude + 180) / 360) * worldSize,
    (0.5 - Math.log((1 + sinLatitude) / (1 - sinLatitude)) / (4 * Math.PI)) * worldSize,
  ];
}

function clusterProperties(porciniCount: number, finferliCount: number): MushroomFeatureProperties {
  const count = porciniCount + finferliCount;
  const species = porciniCount > 0 && finferliCount > 0
    ? 'mixed' as const
    : porciniCount > 0 ? 'porcini' as const : 'finferli' as const;
  return {
    species,
    count,
    label: species === 'mixed'
      ? `P${porciniCount} F${finferliCount}`
      : `${species === 'porcini' ? 'P' : 'F'}${count > 1 ? count : ''}`,
    porciniCount,
    finferliCount,
  };
}

/**
 * Accorpa i marker che sullo schermo risulterebbero quasi sovrapposti.
 * Il calcolo è indipendente dalla camera: legge solo lo zoom già raggiunto e
 * non invia alcun comando a MapLibre.
 */
export function clusterMushroomFeatures(
  features: MushroomMapFeature[],
  zoom: number,
  radiusPx = CLUSTER_RADIUS_PX,
): MushroomMapFeature[] {
  if (features.length < 2 || !Number.isFinite(zoom) || zoom >= MAX_CLUSTER_ZOOM) return features;

  const pixels = features.map((feature) => mercatorPixel(feature.geometry.coordinates, zoom));
  const parent = features.map((_, index) => index);
  const cells = new Map<string, number[]>();
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    while (parent[index] !== index) {
      const next = parent[index];
      parent[index] = root;
      index = next;
    }
    return root;
  };
  const unite = (left: number, right: number) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };

  pixels.forEach(([x, y], index) => {
    const cellX = Math.floor(x / radiusPx);
    const cellY = Math.floor(y / radiusPx);
    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        const candidates = cells.get(`${cellX + offsetX}:${cellY + offsetY}`) ?? [];
        for (const candidate of candidates) {
          if (Math.hypot(x - pixels[candidate][0], y - pixels[candidate][1]) <= radiusPx) {
            unite(index, candidate);
          }
        }
      }
    }
    const key = `${cellX}:${cellY}`;
    cells.set(key, [...(cells.get(key) ?? []), index]);
  });

  const groups = new Map<number, number[]>();
  features.forEach((_, index) => {
    const root = find(index);
    groups.set(root, [...(groups.get(root) ?? []), index]);
  });

  return [...groups.values()].map((indices) => {
    if (indices.length === 1) return features[indices[0]];
    let porciniCount = 0;
    let finferliCount = 0;
    let longitudeTotal = 0;
    let latitudeTotal = 0;
    let weightTotal = 0;
    for (const index of indices) {
      const feature = features[index];
      const weight = feature.properties.count;
      porciniCount += feature.properties.porciniCount;
      finferliCount += feature.properties.finferliCount;
      longitudeTotal += feature.geometry.coordinates[0] * weight;
      latitudeTotal += feature.geometry.coordinates[1] * weight;
      weightTotal += weight;
    }
    return {
      type: 'Feature',
      id: `cluster-${indices.map((index) => features[index].id ?? index).join('-')}`,
      geometry: {
        type: 'Point',
        coordinates: [longitudeTotal / weightTotal, latitudeTotal / weightTotal],
      },
      properties: clusterProperties(porciniCount, finferliCount),
    };
  });
}

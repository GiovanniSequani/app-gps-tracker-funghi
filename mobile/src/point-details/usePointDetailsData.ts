import React from 'react';
import { isAbortError, toUserFacingError } from './errors';
import { loadTerrainDetails } from './terrainClient';
import type {
  PointCoordinate,
  ResourceState,
  TerrainDetails,
  WeatherDetails,
} from './types';
import { loadWeatherDetails } from './weatherClient';

type PointDetailsDataState = {
  weather: ResourceState<WeatherDetails>;
  terrain: ResourceState<TerrainDetails>;
  retry: () => void;
};

export function usePointDetailsData(
  point: PointCoordinate,
): PointDetailsDataState {
  const [retryToken, setRetryToken] = React.useState(0);
  const [weather, setWeather] = React.useState<ResourceState<WeatherDetails>>({
    status: 'loading',
  });
  const [terrain, setTerrain] = React.useState<ResourceState<TerrainDetails>>({
    status: 'loading',
  });
  const requestIdRef = React.useRef(0);

  React.useEffect(() => {
    const requestId = ++requestIdRef.current;
    const controller = new AbortController();
    setWeather({ status: 'loading' });
    setTerrain({ status: 'loading' });

    void loadWeatherDetails(point, controller.signal)
      .then((result) => {
        if (controller.signal.aborted || requestId !== requestIdRef.current) return;
        if (result.status === 'ready') {
          setWeather({ status: 'ready', data: result.data });
        } else if (result.status === 'outside') {
          setWeather({ status: 'outside' });
        } else {
          setWeather({
            status: 'unavailable',
            message: result.reason ?? 'Dati meteo non disponibili.',
          });
        }
      })
      .catch((error: unknown) => {
        if (
          controller.signal.aborted ||
          requestId !== requestIdRef.current ||
          isAbortError(error)
        ) {
          return;
        }
        setWeather({ status: 'error', message: toUserFacingError(error) });
      });

    void loadTerrainDetails(point, controller.signal)
      .then((result) => {
        if (controller.signal.aborted || requestId !== requestIdRef.current) return;
        if (result.status === 'ready') {
          setTerrain({ status: 'ready', data: result.data });
        } else if (result.status === 'outside') {
          setTerrain({ status: 'outside' });
        } else {
          setTerrain({
            status: 'unavailable',
            message: result.reason ?? 'Dati del terreno non disponibili.',
          });
        }
      })
      .catch((error: unknown) => {
        if (
          controller.signal.aborted ||
          requestId !== requestIdRef.current ||
          isAbortError(error)
        ) {
          return;
        }
        setTerrain({ status: 'error', message: toUserFacingError(error) });
      });

    return () => {
      controller.abort();
    };
  }, [point.latitude, point.longitude, retryToken]);

  const retry = React.useCallback(() => {
    setRetryToken((value) => value + 1);
  }, []);

  return { weather, terrain, retry };
}


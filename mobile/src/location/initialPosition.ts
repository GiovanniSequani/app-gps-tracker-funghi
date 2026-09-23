export const PROVISIONAL_POSITION_MAX_AGE_MS = 10 * 60 * 1000;
export const PROVISIONAL_POSITION_MAX_ACCURACY_METERS = 500;
export const PRECISE_POSITION_MAX_ACCURACY_METERS = 100;

export type PositionSample = {
  timestamp: number;
  coords: {
    latitude: number;
    longitude: number;
    accuracy?: number | null;
  };
};

export function isUsableProvisionalPosition(sample: PositionSample | null, now = Date.now()): boolean {
  if (!sample) return false;
  const { latitude, longitude, accuracy } = sample.coords;
  const age = now - sample.timestamp;
  return Number.isFinite(latitude)
    && Number.isFinite(longitude)
    && age >= 0
    && age <= PROVISIONAL_POSITION_MAX_AGE_MS
    && accuracy !== null
    && accuracy !== undefined
    && Number.isFinite(accuracy)
    && accuracy <= PROVISIONAL_POSITION_MAX_ACCURACY_METERS;
}

export function isApproximatePosition(sample: PositionSample, provisional = false): boolean {
  if (provisional) return true;
  const accuracy = sample.coords.accuracy;
  return accuracy === null
    || accuracy === undefined
    || !Number.isFinite(accuracy)
    || accuracy > PRECISE_POSITION_MAX_ACCURACY_METERS;
}

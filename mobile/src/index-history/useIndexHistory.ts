import React from 'react';
import { IndexRequestGate } from '../index-data/requestGate';
import { isAbortError, PointDataError, toUserFacingError } from '../point-details/errors';
import type { PointCoordinate } from '../point-details/types';
import { loadIndexHistoryPoint } from './client';
import { IndexHistoryOutsideCoverageError } from './errors';
import type { IndexHistoryLoader, IndexHistoryState } from './types';

export function useIndexHistory(
  point: PointCoordinate | null,
  enabled: boolean,
  loader: IndexHistoryLoader = loadIndexHistoryPoint,
) {
  const [state, setState] = React.useState<IndexHistoryState>({ status: 'loading' });
  const [retryToken, setRetryToken] = React.useState(0);
  const gateRef = React.useRef<IndexRequestGate | null>(null);
  if (!gateRef.current) gateRef.current = new IndexRequestGate();

  React.useEffect(() => {
    const gate = gateRef.current!;
    const { requestId, controller } = gate.begin();
    if (!enabled || !point) {
      setState({ status: 'loading' });
      return () => gate.cancel();
    }
    setState({ status: 'loading' });
    void loader(point, controller.signal).then(
      (data) => {
        if (gate.accepts(requestId, controller.signal)) setState({ status: 'ready', data });
      },
      (error: unknown) => {
        if (isAbortError(error) || !gate.accepts(requestId, controller.signal)) return;
        if (error instanceof IndexHistoryOutsideCoverageError) {
          setState({ status: 'outside' });
          return;
        }
        setState({
          status:
            error instanceof PointDataError && (error.code === 'contract' || error.code === 'http')
              ? 'unavailable'
              : 'error',
          message:
            error instanceof PointDataError && error.code === 'contract'
              ? error.message
              : toUserFacingError(error),
        });
      },
    );
    return () => controller.abort();
  }, [enabled, loader, point?.latitude, point?.longitude, retryToken]);

  const retry = React.useCallback(() => setRetryToken((value) => value + 1), []);
  return { state, retry };
}

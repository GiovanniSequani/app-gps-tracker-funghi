import React from 'react';
import { isAbortError, PointDataError, toUserFacingError } from '../point-details/errors';
import type { PointCoordinate } from '../point-details/types';
import { loadIndexPoint } from './client';
import { IndexOutsideCoverageError } from './errors';
import { IndexRequestGate } from './requestGate';
import type { IndexPointLoader, IndexPointState } from './types';

export function useIndexPoint(
  point: PointCoordinate | null,
  enabled: boolean,
  loader: IndexPointLoader = loadIndexPoint,
) {
  const [state, setState] = React.useState<IndexPointState>({ status: 'loading' });
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
        if (!gate.accepts(requestId, controller.signal)) return;
        setState({ status: 'ready', data });
      },
      (error: unknown) => {
        if (
          isAbortError(error) ||
          !gate.accepts(requestId, controller.signal)
        ) return;
        if (error instanceof IndexOutsideCoverageError) {
          setState({ status: 'outside' });
          return;
        }
        setState({
          status:
            error instanceof PointDataError &&
            (error.code === 'contract' || error.code === 'http')
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

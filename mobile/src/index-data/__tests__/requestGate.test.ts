import { describe, expect, it } from 'vitest';
import { IndexRequestGate, shouldAcceptIndexResponse } from '../requestGate';

describe('index request stale gate', () => {
  it('accetta soltanto la richiesta corrente non annullata', () => {
    expect(shouldAcceptIndexResponse(2, 2, false)).toBe(true);
    expect(shouldAcceptIndexResponse(1, 2, false)).toBe(false);
    expect(shouldAcceptIndexResponse(2, 2, true)).toBe(false);
  });

  it('annulla la richiesta precedente e ne ignora la risposta stale', () => {
    const gate = new IndexRequestGate();
    const first = gate.begin();
    const second = gate.begin();
    expect(first.controller.signal.aborted).toBe(true);
    expect(gate.accepts(first.requestId, first.controller.signal)).toBe(false);
    expect(gate.accepts(second.requestId, second.controller.signal)).toBe(true);
    gate.cancel();
    expect(gate.accepts(second.requestId, second.controller.signal)).toBe(false);
  });
});

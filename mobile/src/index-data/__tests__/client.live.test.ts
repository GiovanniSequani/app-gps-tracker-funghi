import { describe, expect, it } from 'vitest';
import { buildPorciniAnalysis } from '../analysis';
import { loadIndexPoint } from '../client';

const live = describe.runIf(process.env.RUN_LIVE_INDEX_DATA === '1');

live('public index-data client', () => {
  it('scopre la versione corrente e decodifica soltanto la cella richiesta', async () => {
    const data = await loadIndexPoint({ latitude: 46, longitude: 11 });
    expect(data.version).toBeTruthy();
    expect(data.indexDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(data.row).toBeGreaterThanOrEqual(0);
    expect(data.col).toBeGreaterThanOrEqual(0);
    expect(data.porciniScore === null || Number.isFinite(data.porciniScore)).toBe(true);
    expect(data.finferliScore === null || Number.isFinite(data.finferliScore)).toBe(true);
    const analysis = buildPorciniAnalysis(data);
    const ids = [...analysis.favorable, ...analysis.unfavorable].map((factor) => factor.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

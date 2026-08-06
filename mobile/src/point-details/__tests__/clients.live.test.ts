import { describe, expect, it } from 'vitest';
import { loadTerrainDetails } from '../terrainClient';
import { loadWeatherDetails } from '../weatherClient';

const live = describe.runIf(process.env.RUN_LIVE_POINT_DETAILS === '1');
const TEST_POINT = { latitude: 46, longitude: 11 };

live('public point details clients', () => {
  it('loads only the current weather cell and aligns all published dates', async () => {
    const result = await loadWeatherDetails(TEST_POINT);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.data.days).toHaveLength(20);
    expect(result.data.cell).toEqual({ row: 22, col: 33 });
    expect(result.data.days.map((day) => day.date)).toEqual(result.data.dates);
  });

  it('discovers and decodes the single required terrain chunk', async () => {
    const result = await loadTerrainDetails(TEST_POINT);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.data.chunk.path).toMatch(/\.bin$/);
    expect(result.data.cell.localRow).toBeGreaterThanOrEqual(0);
    expect(result.data.cell.localCol).toBeGreaterThanOrEqual(0);
  });
});


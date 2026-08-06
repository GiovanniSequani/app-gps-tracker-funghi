import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('map mounting invariant', () => {
  it('mantiene un solo MemoMapCanvas fuori dai modal dei dettagli', () => {
    const source = readFileSync(resolve(process.cwd(), 'App.tsx'), 'utf8');
    expect(source.match(/<MemoMapCanvas\b/g)).toHaveLength(1);
    const mapPosition = source.indexOf('<MemoMapCanvas');
    const detailsModal = source.indexOf('visible={pointDetailsPoint !== null}');
    const analysisModal = source.indexOf('visible={indexAnalysisPoint !== null}');
    expect(mapPosition).toBeGreaterThan(0);
    expect(detailsModal).toBeGreaterThan(mapPosition);
    expect(analysisModal).toBeGreaterThan(mapPosition);
    const openAnalysisBody = source.slice(
      source.indexOf('const openIndexAnalysis'),
      source.indexOf('const closeIndexAnalysis'),
    );
    expect(openAnalysisBody).not.toMatch(/runCameraCommand|centerCamera|setCoordinateSelection/);
  });
});

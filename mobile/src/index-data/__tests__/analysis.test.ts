import { describe, expect, it } from 'vitest';
import { buildPorciniAnalysis, qualitativeRating } from '../analysis';
import { analysisPoint } from './fixtures';

const INTERNAL_NAMES =
  /drying_total|drying_exposure_static|low_humidity_days|trigger|post_rain_score|rain_need_factor|temp_score|humidity_score|retention_static|temporal_phase|presence_carryover/i;

describe('analisi indice porcini', () => {
  it('classifica con le soglie qualitative canoniche', () => {
    expect(qualitativeRating(0.8).label).toBe('Molto favorevole');
    expect(qualitativeRating(0.6).label).toBe('Favorevole');
    expect(qualitativeRating(0.52).label).toBe('Debolmente favorevole');
    expect(qualitativeRating(0.47).label).toBe('Debolmente sfavorevole');
    expect(qualitativeRating(0.3).label).toBe('Sfavorevole');
    expect(qualitativeRating(0.1).label).toBe('Molto sfavorevole');
  });

  it('assegna ogni diagnostico a una sola categoria e mantiene l’ordinamento', () => {
    const analysis = buildPorciniAnalysis(analysisPoint());
    const factors = [...analysis.favorable, ...analysis.unfavorable];
    expect(factors.map((factor) => factor.id).sort()).toEqual([
      'drying', 'habitat', 'rain', 'temperature', 'temporal', 'water',
    ]);
    const sources = factors.flatMap((factor) => factor.sourceIds);
    expect(new Set(sources).size).toBe(sources.length);
    expect(analysis.favorable[0].importance).toBeGreaterThanOrEqual(
      analysis.favorable.at(-1)?.importance ?? 0,
    );
  });

  it('inverte sempre il rischio di asciugamento e dichiara la direzione', () => {
    const analysis = buildPorciniAnalysis(analysisPoint({ drying_total: 0.75 }));
    const drying = [...analysis.favorable, ...analysis.unfavorable]
      .find((factor) => factor.id === 'drying');
    expect(drying?.evidence).toBe('Sfavorevole');
    expect(drying?.details.join(' ')).toMatch(/più basso è meglio/i);
    expect(drying?.help).toMatch(/più bassa è sempre migliore/i);
  });

  it('espone misure, unità e direzioni senza nomi interni', () => {
    const analysis = buildPorciniAnalysis(analysisPoint());
    const factors = [...analysis.favorable, ...analysis.unfavorable];
    const visible = factors.flatMap((factor) => [factor.title, factor.evidence, factor.help, ...factor.details]).join(' ');
    expect(visible).not.toMatch(INTERNAL_NAMES);
    expect(visible).toMatch(/85 su 100/i);
    expect(visible).toMatch(/3 giorni/i);
    expect(visible).toMatch(/1,2 volte il riferimento/i);
    expect(visible).toMatch(/1,6 punti aggiunti/i);
  });

  it('non ricava la fase temporale da incubation', () => {
    const point = analysisPoint({ incubation: 0.99, temporal_phase: 0 });
    point.diagnosticLabels.temporal_phase = 'non_determinabile';
    const factors = [...buildPorciniAnalysis(point).favorable, ...buildPorciniAnalysis(point).unfavorable];
    expect(factors.find((factor) => factor.id === 'temporal')).toBeUndefined();
  });
});

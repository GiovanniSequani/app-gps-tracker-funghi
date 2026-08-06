import type { IndexDiagnosticName, IndexPointData } from './types';

export type AnalysisTone = 'favorable' | 'unfavorable';
export type IndexFactorCategory =
  | 'habitat'
  | 'rain'
  | 'temperature'
  | 'water'
  | 'drying'
  | 'temporal';

export type IndexAnalysisFactor = {
  id: IndexFactorCategory;
  sourceIds: IndexDiagnosticName[];
  title: string;
  details: string[];
  evidence: string;
  help: string;
  tone: AnalysisTone;
  importance: number;
};

export type PorciniAnalysis = {
  favorable: IndexAnalysisFactor[];
  unfavorable: IndexAnalysisFactor[];
};

const scoreFormatter = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 1 });
const decimalFormatter = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 2 });

function indicator(value: number): string {
  return `${Math.round(Math.min(Math.max(value, 0), 1) * 100)} su 100`;
}

export function qualitativeRating(
  quality: number,
): { label: string; tone: AnalysisTone } {
  if (quality >= 0.75) return { label: 'Molto favorevole', tone: 'favorable' };
  if (quality >= 0.55) return { label: 'Favorevole', tone: 'favorable' };
  if (quality >= 0.5) return { label: 'Debolmente favorevole', tone: 'favorable' };
  if (quality >= 0.45) return { label: 'Debolmente sfavorevole', tone: 'unfavorable' };
  if (quality >= 0.25) return { label: 'Sfavorevole', tone: 'unfavorable' };
  return { label: 'Molto sfavorevole', tone: 'unfavorable' };
}

function category(
  props: Omit<IndexAnalysisFactor, 'evidence' | 'tone'> & { quality: number },
): IndexAnalysisFactor {
  const rating = qualitativeRating(props.quality);
  return { ...props, evidence: rating.label, tone: rating.tone };
}

function friendlyTemporalPhase(label: string): string {
  return {
    fase_favorevole: 'Fase favorevole',
    troppo_precoce: 'Ancora precoce',
    troppo_tardi: 'Fase probabilmente superata',
  }[label] ?? label.replaceAll('_', ' ');
}

export function buildPorciniAnalysis(data: IndexPointData): PorciniAnalysis {
  const factors: IndexAnalysisFactor[] = [];
  const diagnostics = data.diagnostics;
  const weights = data.context.dynamicWeights;

  if (diagnostics.habitat !== null) {
    factors.push(category({
      id: 'habitat',
      sourceIds: ['habitat'],
      title: 'Habitat del luogo',
      quality: diagnostics.habitat,
      details: [`Idoneità di quota e copertura forestale: ${indicator(diagnostics.habitat)}.`],
      help:
        'Considera soprattutto la quota e la composizione della copertura forestale, distinguendo la componente di latifoglie da quella di conifere. Le quote considerate dal modello sono comprese indicativamente tra 350 e 2.250 metri.',
      importance: weights.habitat ?? 0.28,
    }));
  }

  if (diagnostics.trigger !== null) {
    const details = [`Pioggia accumulata prima dell’avvio: ${indicator(diagnostics.trigger)}.`];
    if (diagnostics.post_rain_score !== null) {
      details.push(`Pioggia accumulata nei giorni successivi: ${indicator(diagnostics.post_rain_score)}.`);
    }
    if (diagnostics.rain_need_factor !== null) {
      details.push(
        `Pioggia ancora necessaria: ${decimalFormatter.format(diagnostics.rain_need_factor)} volte il riferimento (più basso è meglio).`,
      );
    }
    if (diagnostics.rain_recovery_seed !== null) {
      details.push(
        `Beneficio della pioggia recente: ${scoreFormatter.format(diagnostics.rain_recovery_seed)} punti aggiunti.`,
      );
    }
    factors.push(category({
      id: 'rain',
      sourceIds: ['trigger', 'post_rain_score', 'rain_need_factor', 'rain_recovery_seed'],
      title: 'Pioggia e avvio del ciclo',
      quality: diagnostics.trigger,
      details,
      help:
        'Confronta la pioggia cumulata prima e dopo l’avvio del ciclo su finestre comprese tra 7 e 16 giorni. Gli accumuli di riferimento vanno da pochi millimetri fino a circa 95 mm prima dell’avvio e 75 mm nei giorni successivi. Più pioggia utile aumenta il giudizio; una quantità ancora necessaria più bassa è migliore.',
      importance: weights.trigger ?? 0.3,
    }));
  }

  if (diagnostics.temp_score !== null) {
    const details = [
      `Adeguatezza di temperature minime, medie e massime: ${indicator(diagnostics.temp_score)}.`,
    ];
    const band = data.diagnosticLabels.temperature_band?.replaceAll('_', ' ');
    if (band) details.push(`Fascia termica rilevata: ${band}.`);
    factors.push(category({
      id: 'temperature',
      sourceIds: ['temp_score', 'temperature_band'],
      title: 'Temperatura',
      quality: diagnostics.temp_score,
      details,
      help:
        'Confronta temperature minime, medie e massime nei giorni considerati. Le fasce centrali più favorevoli sono circa 5–13 °C per le minime, 10–18 °C per le medie e 15–24 °C per le massime; valori molto più freddi o caldi riducono il giudizio.',
      importance: (weights.incubation ?? 0.22) * 0.42,
    }));
  }

  if (diagnostics.moisture !== null) {
    const details = [`Disponibilità complessiva di umidità: ${indicator(diagnostics.moisture)}.`];
    if (diagnostics.humidity_score !== null) {
      details.push(`Adeguatezza dell’umidità media e minima dell’aria: ${indicator(diagnostics.humidity_score)}.`);
    }
    if (diagnostics.retention_static !== null) {
      details.push(`Capacità del luogo di trattenere acqua: ${indicator(diagnostics.retention_static)} (più alto è meglio).`);
    }
    if (diagnostics.low_humidity_days !== null) {
      details.push(
        `Giorni con umidità minima sotto il 42%: ${Math.round(diagnostics.low_humidity_days)} giorni (più basso è meglio).`,
      );
    }
    factors.push(category({
      id: 'water',
      sourceIds: ['moisture', 'humidity_score', 'retention_static', 'low_humidity_days'],
      title: 'Umidità e riserva d’acqua',
      quality: diagnostics.moisture,
      details,
      help:
        'Combina umidità media e minima dell’aria, giorni con umidità minima sotto il 42%, pioggia arrivata dopo l’avvio e capacità del luogo di conservare acqua. L’osservazione riguarda una finestra compresa tra 7 e 16 giorni. Valori più alti e meno giornate secche sono migliori.',
      importance: weights.moisture ?? 0.16,
    }));
  }

  if (diagnostics.drying_total !== null) {
    const details = [
      `Perdita potenziale di umidità: ${indicator(diagnostics.drying_total)} (più basso è meglio).`,
    ];
    if (diagnostics.stress !== null) {
      details.push(`Protezione da caldo, vento e aria secca: ${indicator(diagnostics.stress)} (più alto è meglio).`);
    }
    if (diagnostics.drying_exposure_static !== null) {
      details.push(
        `Esposizione del terreno all’asciugamento: ${indicator(diagnostics.drying_exposure_static)} (più basso è meglio).`,
      );
    }
    factors.push(category({
      id: 'drying',
      sourceIds: ['drying_total', 'stress', 'drying_exposure_static'],
      title: 'Rischio di asciugamento',
      quality: 1 - diagnostics.drying_total,
      details,
      help:
        'La parte meteorologica combina umidità bassa, raffiche massime e temperature elevate; pesa circa il 62%. Il restante 38% dipende dall’esposizione del terreno all’asciugamento. In questa categoria una perdita potenziale più bassa è sempre migliore.',
      importance: (weights.moisture ?? 0.16) * 0.55 + (weights.incubation ?? 0.22) * 0.1,
    }));
  }

  const temporalPhase = data.diagnosticLabels.temporal_phase;
  if (
    temporalPhase === 'fase_favorevole' ||
    temporalPhase === 'troppo_precoce' ||
    temporalPhase === 'troppo_tardi'
  ) {
    const favorable = temporalPhase === 'fase_favorevole';
    const details = [`Indicazione temporale: ${friendlyTemporalPhase(temporalPhase)}.`];
    if (diagnostics.presence_carryover !== null) {
      details.push(
        `Continuità delle condizioni dai giorni precedenti: ${scoreFormatter.format(diagnostics.presence_carryover)} punti.`,
      );
    }
    factors.push({
      id: 'temporal',
      sourceIds: ['temporal_phase', 'presence_carryover'],
      title: 'Dinamica nel tempo',
      details,
      evidence: favorable ? 'Fase favorevole' : 'Da interpretare con cautela',
      help:
        'Confronta l’andamento combinato di pioggia, temperatura e umidità su più finestre tra 7 e 16 giorni. Serve a capire se le condizioni stanno maturando, sono nella fase più favorevole o la stanno superando. È un’indicazione cauta del modello, non una previsione certa.',
      tone: favorable ? 'favorable' : 'unfavorable',
      importance: 0.18,
    });
  }

  return {
    favorable: factors
      .filter((factor) => factor.tone === 'favorable')
      .sort((a, b) => b.importance - a.importance),
    unfavorable: factors
      .filter((factor) => factor.tone === 'unfavorable')
      .sort((a, b) => b.importance - a.importance),
  };
}

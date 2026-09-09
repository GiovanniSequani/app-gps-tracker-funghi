import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const editor = fs.readFileSync(path.resolve(__dirname, '../CloudTrackEditor.tsx'), 'utf8');

describe('editor mobile della traccia cloud', () => {
  it('separa accorciamento e ritrovamenti', () => {
    expect(editor).toContain("useState<'trim' | 'mushrooms'>('trim')");
    expect(editor).toContain('>Accorcia</Text>');
    expect(editor).toContain('>Ritrovamenti</Text>');
    expect(editor).toContain("section === 'trim'");
  });

  it('usa pulsanti accessibili per la quantità', () => {
    expect(editor).toContain('Diminuisci quantità');
    expect(editor).toContain('Aumenta quantità');
    expect(editor).toContain('Math.max(1, value - 1)');
    expect(editor).toContain('Math.min(10000, value + 1)');
    expect(editor).not.toContain('keyboardType="number-pad"');
  });

  it('distingue l’applicazione al punto dal salvataggio generale', () => {
    expect(editor).toContain('Conferma ritrovamento');
    expect(editor).toContain('Ritrovamento pronto. Salva tutte le modifiche');
    expect(editor).toContain('Salva tutte le modifiche');
  });

  it('somma nel riepilogo waypoint GPX e marker cloud senza duplicare quelli iniziali', () => {
    expect(editor).toContain('originalCloudTotals');
    expect(editor).toContain('gpxTotals.porcini + markerTotals.porcini');
    expect(editor).toContain('gpxTotals.finferli + markerTotals.finferli');
  });
});

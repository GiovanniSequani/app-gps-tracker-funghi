import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('IndiceScreen content', () => {
  const source = readFileSync(resolve(process.cwd(), 'IndiceScreen.tsx'), 'utf8');

  it('uses the published tile thresholds and colors', () => {
    for (const threshold of ['0', '5', '15', '30', '45', '60', '75', '90', '100']) {
      expect(source).toContain(`score: ${threshold},`);
    }
    for (const rgb of ['180,230,255', '100,200,255', '80,180,90', '255,230,70', '255,120,60', '210,60,40', '120,78,42']) {
      expect(source).toContain(rgb);
    }
  });

  it('does not expose implementation or manual dataset controls', () => {
    expect(source).not.toContain('DATASET TILE');
    expect(source).not.toContain('Scala RGB');
    expect(source).not.toContain('backend');
    expect(source).not.toContain('TextInput');
  });

  it('keeps one legend and the user-facing scoring explanation', () => {
    expect(source.match(/>LEGENDA</g)).toHaveLength(1);
    expect(source).toContain('Terreno e bosco');
    expect(source).toContain('Pioggia e avvio del ciclo');
    expect(source).toContain('Rischio di asciugamento');
  });
});

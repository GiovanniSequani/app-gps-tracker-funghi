import { describe, expect, it } from 'vitest';
import {
  FINFERLI_DIAGNOSTICS_MESSAGE,
  FINFERLI_DIAGNOSTICS_TITLE,
} from '../messages';

describe('diagnostica finferli', () => {
  it('dichiara che lo score è disponibile ma i fattori non sono pubblicati', () => {
    expect(FINFERLI_DIAGNOSTICS_TITLE).toBe('Diagnostica non ancora disponibile');
    expect(FINFERLI_DIAGNOSTICS_MESSAGE).toMatch(/punteggio finferli è disponibile/i);
    expect(FINFERLI_DIAGNOSTICS_MESSAGE).toMatch(/backend non pubblica ancora i fattori/i);
  });
});

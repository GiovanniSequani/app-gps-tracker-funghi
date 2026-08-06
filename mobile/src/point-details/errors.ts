export type PointDataErrorCode =
  | 'configuration'
  | 'network'
  | 'http'
  | 'contract'
  | 'aborted';

export class PointDataError extends Error {
  constructor(
    public readonly code: PointDataErrorCode,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'PointDataError';
  }
}

export function isAbortError(error: unknown): boolean {
  return (
    (typeof DOMException !== 'undefined' &&
      error instanceof DOMException &&
      error.name === 'AbortError') ||
    (error instanceof PointDataError && error.code === 'aborted') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

export function toUserFacingError(error: unknown): string {
  if (error instanceof PointDataError) {
    if (error.code === 'configuration') {
      return 'Configurazione Supabase pubblica non disponibile.';
    }
    if (error.code === 'network') {
      return 'Errore di rete. Controlla la connessione e riprova.';
    }
    if (error.code === 'http') {
      return 'Il servizio dati non è temporaneamente disponibile.';
    }
    if (error.code === 'contract') {
      return 'I dati ricevuti non rispettano il formato atteso.';
    }
  }
  return 'Impossibile caricare i dati. Riprova.';
}

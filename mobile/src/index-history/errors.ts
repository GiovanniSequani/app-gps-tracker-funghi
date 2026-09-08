export class IndexHistoryOutsideCoverageError extends Error {
  constructor(message = 'Il punto è fuori dalla griglia dello storico indice.') {
    super(message);
    this.name = 'IndexHistoryOutsideCoverageError';
  }
}

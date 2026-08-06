export class IndexOutsideCoverageError extends Error {
  constructor(message = 'Il punto è fuori dalla griglia dell’indice.') {
    super(message);
    this.name = 'IndexOutsideCoverageError';
  }
}

export function shouldAcceptIndexResponse(
  requestId: number,
  currentRequestId: number,
  aborted: boolean,
): boolean {
  return !aborted && requestId === currentRequestId;
}

export class IndexRequestGate {
  private currentId = 0;
  private controller: AbortController | null = null;

  begin(): { requestId: number; controller: AbortController } {
    this.controller?.abort();
    this.controller = new AbortController();
    this.currentId += 1;
    return { requestId: this.currentId, controller: this.controller };
  }

  accepts(requestId: number, signal: AbortSignal): boolean {
    return shouldAcceptIndexResponse(requestId, this.currentId, signal.aborted);
  }

  cancel(): void {
    this.controller?.abort();
  }
}

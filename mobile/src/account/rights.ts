export type AccountExportStatus = 'pending' | 'building' | 'retry' | 'ready' | 'expired' | 'cleaning';

export type AccountExportJob = {
  id: string;
  status: AccountExportStatus;
  storage_path: string;
  requested_at: string;
  ready_at: string | null;
  expires_at: string | null;
  size_bytes: number | null;
  last_error_code: string | null;
  updated_at: string;
};

export type DeletionVerificationResponse = { accepted: true; expires_in_minutes?: number };
export type DeletionConfirmationResponse = { confirmed: true; job_id: string };

export function isExportDownloadable(job: AccountExportJob, now = Date.now()): boolean {
  if (job.status !== 'ready' || !job.expires_at) return false;
  const expiresAt = new Date(job.expires_at).getTime();
  return Number.isFinite(expiresAt) && expiresAt > now;
}

export function getExportStatusCopy(job: AccountExportJob): { label: string; description: string; tone: 'neutral' | 'warning' | 'success' } {
  switch (job.status) {
    case 'pending': return { label: 'In coda', description: 'La richiesta è stata ricevuta. La preparazione avviene in background.', tone: 'neutral' };
    case 'building': return { label: 'Preparazione in corso', description: 'Il server sta creando l’archivio personale.', tone: 'neutral' };
    case 'retry': return { label: 'Nuovo tentativo previsto', description: 'Si è verificato un problema temporaneo. Il backend riproverà automaticamente.', tone: 'warning' };
    case 'ready': return isExportDownloadable(job)
      ? { label: 'Pronto da scaricare', description: 'Il file è privato e rimane disponibile solo fino alla scadenza indicata.', tone: 'success' }
      : { label: 'Download scaduto', description: 'La scadenza è trascorsa. Aggiorna lo stato o richiedi un nuovo export.', tone: 'warning' };
    case 'expired': return { label: 'Download scaduto', description: 'Il file temporaneo non è più disponibile. Puoi richiedere un nuovo export.', tone: 'warning' };
    case 'cleaning': return { label: 'Rimozione file scaduto', description: 'Il backend sta eliminando l’archivio temporaneo scaduto.', tone: 'neutral' };
  }
}

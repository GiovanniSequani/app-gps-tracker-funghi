export type AccountState = 'active' | 'restricted' | 'deletion_pending';
export type RestrictionReason = 'terms_outdated' | 'terms_refused' | 'inactive' | 'security';
export type MeaningfulActivityKind = 'interactive_login' | 'foreground_session' | 'account_action';

export type AccountLifecyclePublicConfig = {
  api_available: boolean;
  lifecycle_enabled: boolean;
  current_terms_version: string | null;
  current_privacy_version: string | null;
  reaccept_days: number;
};

export type AccountAccess = {
  account_state: AccountState;
  restriction_reason: RestrictionReason | null;
  terms_version: string | null;
  privacy_version: string | null;
  current_terms_version: string;
  current_privacy_version: string;
  legal_notice_first_seen_at: string | null;
  legal_notice_privacy_version: string | null;
  legal_reaccept_deadline_at: string | null;
  last_meaningful_activity_at: string | null;
  inactivity_delete_after: string | null;
  full_access: boolean;
  needs_terms_action: boolean;
};

export const LEGACY_LIFECYCLE_CONFIG: AccountLifecyclePublicConfig = {
  api_available: false,
  lifecycle_enabled: false,
  current_terms_version: null,
  current_privacy_version: null,
  reaccept_days: 365,
};

export function hasLifecycleFullAccess(
  authenticated: boolean,
  config: AccountLifecyclePublicConfig | null,
  access: AccountAccess | null,
): boolean {
  return Boolean(
    authenticated
    && config?.api_available
    && config.lifecycle_enabled
    && access?.full_access === true,
  );
}

export function canChangeLegalAcceptance(access: AccountAccess | null): boolean {
  return Boolean(
    access
    && access.account_state !== 'deletion_pending'
    && access.restriction_reason !== 'security',
  );
}

export function bundledDocumentsMatch(config: AccountLifecyclePublicConfig | null): boolean {
  return Boolean(
    config
    && config.current_terms_version === '1.0'
    && config.current_privacy_version === '1.0',
  );
}

export function lifecycleStateCopy(access: AccountAccess | null) {
  if (!access) return { eyebrow: 'Stato non verificabile', title: 'Accesso temporaneamente limitato', description: 'Non è stato possibile verificare lo stato dell’account. Le funzioni riservate restano bloccate finché il server non risponde.', tone: 'unknown' as const };
  if (access.account_state === 'deletion_pending') return { eyebrow: 'Eliminazione richiesta', title: 'Account in eliminazione', description: 'La richiesta è in lavorazione. Le funzioni riservate non sono disponibili e questa schermata non indica che la cancellazione sia già completata.', tone: 'danger' as const };
  switch (access.restriction_reason) {
    case 'terms_outdated': return { eyebrow: 'Documenti aggiornati', title: 'È richiesta una nuova accettazione', description: 'Leggi i Termini correnti e l’Informativa privacy. L’accesso completo torna disponibile dopo l’accettazione registrata dal server.', tone: 'warning' as const };
    case 'terms_refused': return { eyebrow: 'Condizioni rifiutate', title: 'Account con accesso limitato', description: 'Hai rifiutato i Termini correnti. Puoi leggerli nuovamente e riattivare l’account accettando la versione corrente.', tone: 'warning' as const };
    case 'inactive': return { eyebrow: 'Account inattivo', title: 'Accesso limitato per inattività', description: 'Il server ha limitato l’account per inattività. Se i documenti sono correnti, una nuova attività esplicita può riattivarlo; altrimenti è richiesta l’accettazione.', tone: 'warning' as const };
    case 'security': return { eyebrow: 'Verifica necessaria', title: 'Accesso limitato per sicurezza', description: 'La riattivazione automatica non è disponibile. Consulta i documenti e contatta l’assistenza senza inviare password, percorsi o coordinate.', tone: 'danger' as const };
    default: return { eyebrow: 'Accesso limitato', title: 'Funzioni riservate non disponibili', description: 'Lo stato restituito dal server non consente l’accesso completo.', tone: 'unknown' as const };
  }
}

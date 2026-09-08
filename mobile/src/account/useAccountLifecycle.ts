import React from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import type { Session } from '@supabase/supabase-js';
import { getAccountLifecyclePublicConfig, getMyAccountAccess, recordMyMeaningfulActivity } from './lifecycleClient';
import { hasLifecycleFullAccess, type AccountAccess, type AccountLifecyclePublicConfig, type MeaningfulActivityKind } from './lifecycle';
import { toAccountError } from './validation';

export type AccountLifecycleState = {
  config: AccountLifecyclePublicConfig | null;
  access: AccountAccess | null;
  loading: boolean;
  error: string | null;
  fullAccess: boolean;
  refresh: (activityKind?: MeaningfulActivityKind) => Promise<AccountAccess | null>;
  applyAccess: (access: AccountAccess) => void;
};

export function useAccountLifecycle(session: Session | null, sessionLoading: boolean): AccountLifecycleState {
  const [config, setConfig] = React.useState<AccountLifecyclePublicConfig | null>(null);
  const [access, setAccess] = React.useState<AccountAccess | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const sequenceRef = React.useRef(0);
  const initialResolutionRef = React.useRef(false);
  const appStateRef = React.useRef<AppStateStatus>(AppState.currentState);
  const sessionRef = React.useRef(session);
  sessionRef.current = session;

  const applyAccess = React.useCallback((next: AccountAccess) => {
    setAccess(next); setError(null); setLoading(false);
  }, []);

  const refresh = React.useCallback(async (activityKind?: MeaningfulActivityKind) => {
    const sequence = ++sequenceRef.current;
    setLoading(true); setError(null);
    try {
      const nextConfig = await getAccountLifecyclePublicConfig();
      if (sequence !== sequenceRef.current) return null;
      setConfig(nextConfig);
      if (!sessionRef.current || !nextConfig.api_available || !nextConfig.lifecycle_enabled) {
        setAccess(null); setLoading(false); return null;
      }
      const nextAccess = activityKind
        ? await recordMyMeaningfulActivity(activityKind)
        : await getMyAccountAccess();
      if (sequence !== sequenceRef.current) return null;
      setAccess(nextAccess); setLoading(false); return nextAccess;
    } catch (cause) {
      if (sequence !== sequenceRef.current) return null;
      setConfig(null); setAccess(null); setError(toAccountError(cause).message); setLoading(false);
      return null;
    }
  }, []);

  React.useEffect(() => {
    if (sessionLoading) return;
    const first = !initialResolutionRef.current;
    initialResolutionRef.current = true;
    // Only an already-open session at process startup is meaningful activity.
    // Later auth changes (including deep links/token refresh) only revalidate.
    void refresh(first && session ? 'foreground_session' : undefined);
  }, [refresh, session?.expires_at, session?.user.id, sessionLoading]);

  React.useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      const previous = appStateRef.current;
      appStateRef.current = next;
      if (next === 'active' && previous !== 'active' && sessionRef.current) {
        void refresh('foreground_session');
      }
    });
    return () => subscription.remove();
  }, [refresh]);

  React.useEffect(() => () => { sequenceRef.current += 1; }, []);

  return {
    config, access, loading, error,
    // Keep the last authoritative access while a foreground refresh is pending.
    // A failed refresh clears config/access and therefore still fails closed.
    fullAccess: hasLifecycleFullAccess(Boolean(session), config, access),
    refresh, applyAccess,
  };
}

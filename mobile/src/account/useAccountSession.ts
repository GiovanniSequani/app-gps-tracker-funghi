import React from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { getMyProfile } from './client';
import { getAccountSupabaseClient, getPersistedAccountSession } from './supabase';
import type { AccountSessionState } from './types';
import { toAccountError } from './validation';

export function useAccountSession(): AccountSessionState {
  const [state, setState] = React.useState<AccountSessionState>({
    session: null,
    username: null,
    offline: false,
    loading: true,
    error: null,
  });

  React.useEffect(() => {
    let active = true;
    let identitySequence = 0;
    let appStateSubscription: { remove: () => void } | null = null;

    const applySession = (session: AccountSessionState['session'], offline = false) => {
      const sequence = ++identitySequence;
      setState({ session, username: null, offline, loading: false, error: null });
      if (!session || offline) return;
      void getMyProfile()
        .then((profile) => {
          if (active && sequence === identitySequence) {
            setState((current) => ({ ...current, username: profile.username }));
          }
        })
        .catch(() => undefined);
    };

    try {
      const supabase = getAccountSupabaseClient();
      const updateRefresh = (nextState: AppStateStatus) => {
        if (nextState === 'active') supabase.auth.startAutoRefresh();
        else supabase.auth.stopAutoRefresh();
      };
      updateRefresh(AppState.currentState);
      appStateSubscription = AppState.addEventListener('change', updateRefresh);

      void supabase.auth.getSession().then(async ({ data, error }) => {
        if (!active) return;
        if (error) {
          const persistedSession = await getPersistedAccountSession().catch(() => null);
          if (!active) return;
          if (persistedSession) {
            applySession(persistedSession, true);
            return;
          }
          setState({ session: null, username: null, offline: false, loading: false, error: toAccountError(error).message });
          return;
        }
        applySession(data.session);
      });
      const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => {
        if (active) applySession(session);
      });
      return () => {
        active = false;
        identitySequence += 1;
        appStateSubscription?.remove();
        subscription.subscription.unsubscribe();
        supabase.auth.stopAutoRefresh();
      };
    } catch (error) {
      setState({ session: null, username: null, offline: false, loading: false, error: toAccountError(error).message });
      return () => {
        active = false;
        appStateSubscription?.remove();
      };
    }
  }, []);

  return state;
}

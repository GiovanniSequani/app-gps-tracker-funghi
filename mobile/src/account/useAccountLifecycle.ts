import React from 'react';
import type { Session } from '@supabase/supabase-js';

import {
  isCachedFullAccessExpired,
  loadAccountLifecycleSnapshot,
  removeAccountLifecycleSnapshot,
  saveAccountLifecycleSnapshot,
} from './lifecycleCache';
import { getAccountLifecyclePublicConfig, getMyAccountAccess, recordMyMeaningfulActivity } from './lifecycleClient';
import { hasLifecycleFullAccess, type AccountAccess, type AccountLifecyclePublicConfig, type MeaningfulActivityKind } from './lifecycle';
import { toAccountError } from './validation';

type AccessSource = 'none' | 'cache' | 'server';

type InternalState = {
  config: AccountLifecyclePublicConfig | null;
  access: AccountAccess | null;
  accessUserId: string | null;
  accessSource: AccessSource;
  cachedFullAccessExpired: boolean;
  loading: boolean;
  error: string | null;
};

export type AccountLifecycleState = {
  config: AccountLifecyclePublicConfig | null;
  access: AccountAccess | null;
  loading: boolean;
  error: string | null;
  fullAccess: boolean;
  usingCachedAccess: boolean;
  cachedFullAccessExpired: boolean;
  authoritativeRestriction: boolean;
  refresh: (activityKind?: MeaningfulActivityKind) => Promise<AccountAccess | null>;
  applyAccess: (access: AccountAccess, userId?: string) => void;
};

const INITIAL_STATE: InternalState = {
  config: null,
  access: null,
  accessUserId: null,
  accessSource: 'none',
  cachedFullAccessExpired: false,
  loading: true,
  error: null,
};

export function useAccountLifecycle(session: Session | null, sessionLoading: boolean): AccountLifecycleState {
  const [state, setState] = React.useState<InternalState>(INITIAL_STATE);
  const stateRef = React.useRef<InternalState>(INITIAL_STATE);
  const sessionRef = React.useRef(session);
  const requestSequenceRef = React.useRef(0);
  const bootstrapSequenceRef = React.useRef(0);
  const initialSessionResolutionRef = React.useRef(false);
  const previousUserIdRef = React.useRef<string | null>(null);
  sessionRef.current = session;

  const updateState = React.useCallback((update: (current: InternalState) => InternalState) => {
    setState((current) => {
      const next = update(current);
      stateRef.current = next;
      return next;
    });
  }, []);

  const applyAccess = React.useCallback((nextAccess: AccountAccess, userIdOverride?: string) => {
    requestSequenceRef.current += 1;
    const userId = userIdOverride ?? sessionRef.current?.user.id ?? null;
    const verifiedAt = Date.now();
    const config = stateRef.current.config;
    updateState((current) => ({
      ...current,
      access: nextAccess,
      accessUserId: userId,
      accessSource: 'server',
      cachedFullAccessExpired: false,
      loading: false,
      error: null,
    }));
    if (userId && config) {
      void saveAccountLifecycleSnapshot(userId, config, nextAccess, verifiedAt).catch(() => undefined);
    }
  }, [updateState]);

  const refresh = React.useCallback(async (activityKind?: MeaningfulActivityKind) => {
    const sequence = ++requestSequenceRef.current;
    const sessionAtStart = sessionRef.current;
    const userId = sessionAtStart?.user.id ?? null;
    updateState((current) => ({
      ...current,
      loading: userId
        ? current.accessUserId !== userId || current.access === null
        : current.config === null,
      error: null,
    }));
    try {
      const nextConfig = await getAccountLifecyclePublicConfig();
      if (sequence !== requestSequenceRef.current || (sessionRef.current?.user.id ?? null) !== userId) return null;
      if (!sessionAtStart || !nextConfig.api_available || !nextConfig.lifecycle_enabled) {
        updateState((current) => ({
          ...current,
          config: nextConfig,
          access: null,
          accessUserId: userId,
          accessSource: 'server',
          cachedFullAccessExpired: false,
          loading: false,
          error: null,
        }));
        if (userId) void removeAccountLifecycleSnapshot(userId).catch(() => undefined);
        return null;
      }

      const nextAccess = activityKind
        ? await recordMyMeaningfulActivity(activityKind)
        : await getMyAccountAccess();
      if (sequence !== requestSequenceRef.current || (sessionRef.current?.user.id ?? null) !== userId) return null;
      const verifiedAt = Date.now();
      updateState((current) => ({
        ...current,
        config: nextConfig,
        access: nextAccess,
        accessUserId: userId,
        accessSource: 'server',
        cachedFullAccessExpired: false,
        loading: false,
        error: null,
      }));
      void saveAccountLifecycleSnapshot(sessionAtStart.user.id, nextConfig, nextAccess, verifiedAt).catch(() => undefined);
      return nextAccess;
    } catch (cause) {
      if (sequence !== requestSequenceRef.current || (sessionRef.current?.user.id ?? null) !== userId) return null;
      // Un errore di rete non è una risposta autoritativa sullo stato account:
      // conserva l'ultimo snapshot invece di trasformarlo in una restrizione.
      updateState((current) => ({
        ...current,
        loading: false,
        error: toAccountError(cause).message,
      }));
      return null;
    }
  }, [updateState]);

  React.useEffect(() => {
    if (sessionLoading) return;
    const bootstrapSequence = ++bootstrapSequenceRef.current;
    const userId = session?.user.id ?? null;
    const previousUserId = previousUserIdRef.current;
    previousUserIdRef.current = userId;
    const firstResolution = !initialSessionResolutionRef.current;
    initialSessionResolutionRef.current = true;

    if (previousUserId && previousUserId !== userId) {
      void removeAccountLifecycleSnapshot(previousUserId).catch(() => undefined);
    }

    void (async () => {
      if (userId) {
        if (
          stateRef.current.accessUserId === userId
          && stateRef.current.accessSource === 'server'
          && stateRef.current.access
        ) {
          if (bootstrapSequence === bootstrapSequenceRef.current) await refresh();
          return;
        }
        const snapshot = await loadAccountLifecycleSnapshot(userId).catch(() => null);
        if (bootstrapSequence !== bootstrapSequenceRef.current) return;
        if (snapshot) {
          updateState(() => ({
            config: snapshot.config,
            access: snapshot.access,
            accessUserId: userId,
            accessSource: 'cache',
            cachedFullAccessExpired: isCachedFullAccessExpired(snapshot),
            loading: false,
            error: null,
          }));
        } else {
          updateState((current) => ({
            ...current,
            access: null,
            accessUserId: userId,
            accessSource: 'none',
            cachedFullAccessExpired: false,
            loading: true,
            error: null,
          }));
        }
      } else {
        updateState((current) => ({
          ...current,
          access: null,
          accessUserId: null,
          accessSource: 'none',
          cachedFullAccessExpired: false,
          loading: current.config === null,
          error: null,
        }));
      }

      if (bootstrapSequence !== bootstrapSequenceRef.current) return;
      await refresh(firstResolution && userId ? 'foreground_session' : undefined);
    })();

    return () => {
      bootstrapSequenceRef.current += 1;
      requestSequenceRef.current += 1;
    };
  }, [refresh, session?.user.id, sessionLoading, updateState]);

  React.useEffect(() => () => {
    bootstrapSequenceRef.current += 1;
    requestSequenceRef.current += 1;
  }, []);

  const sessionUserId = session?.user.id ?? null;
  const accessMatchesSession = Boolean(sessionUserId && state.accessUserId === sessionUserId);
  const authoritativeRestriction = Boolean(
    accessMatchesSession
    && (
      state.access?.full_access === false
      || (state.access !== null && state.access.account_state !== 'active')
      || (
        state.accessSource === 'server'
        && state.access === null
        && state.config
        && (!state.config.api_available || !state.config.lifecycle_enabled)
      )
    ),
  );
  const fullAccess = Boolean(
    accessMatchesSession
    && !state.cachedFullAccessExpired
    && state.access?.account_state === 'active'
    && state.access.restriction_reason === null
    && hasLifecycleFullAccess(Boolean(session), state.config, state.access),
  );

  return {
    config: state.config,
    access: accessMatchesSession ? state.access : null,
    loading: state.loading,
    error: state.error,
    fullAccess,
    usingCachedAccess: accessMatchesSession && state.accessSource === 'cache',
    cachedFullAccessExpired: accessMatchesSession && state.cachedFullAccessExpired,
    authoritativeRestriction,
    refresh,
    applyAccess,
  };
}

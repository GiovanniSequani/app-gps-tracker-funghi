import React from 'react';
import { Linking } from 'react-native';
import 'react-native-url-polyfill/auto';
import { parseAuthCallbackUrl, type AuthCallbackRequest } from './authCallbacks';

export type AuthDeepLinkState =
  | { status: 'pending'; request: AuthCallbackRequest }
  | { status: 'invalid' }
  | null;

export function useAuthDeepLinks(): {
  state: AuthDeepLinkState;
  dismiss: () => void;
} {
  const [state, setState] = React.useState<AuthDeepLinkState>(null);

  const handleUrl = React.useCallback((url: string) => {
    const parsed = parseAuthCallbackUrl(url);
    if (parsed.status === 'valid') setState({ status: 'pending', request: parsed.request });
    else if (parsed.status === 'invalid') setState({ status: 'invalid' });
  }, []);

  React.useEffect(() => {
    let active = true;
    void Linking.getInitialURL()
      .then((url) => {
        if (active && url) handleUrl(url);
      })
      .catch(() => undefined);
    const subscription = Linking.addEventListener('url', ({ url }) => handleUrl(url));
    return () => {
      active = false;
      subscription.remove();
    };
  }, [handleUrl]);

  return {
    state,
    dismiss: React.useCallback(() => setState(null), []),
  };
}

import React from 'react';
import * as Network from 'expo-network';

export function useNetworkAvailability(): boolean | null {
  const [online, setOnline] = React.useState<boolean | null>(null);

  React.useEffect(() => {
    let active = true;
    const apply = (state: Network.NetworkState) => {
      if (active) setOnline(state.isConnected !== false && state.isInternetReachable !== false);
    };
    void Network.getNetworkStateAsync().then(apply).catch(() => {
      if (active) setOnline(null);
    });
    const subscription = Network.addNetworkStateListener(apply);
    return () => { active = false; subscription.remove(); };
  }, []);

  return online;
}

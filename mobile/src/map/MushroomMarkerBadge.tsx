import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { MushroomFeatureProperties } from './mushroomMarkers';

type Props = MushroomFeatureProperties & {
  accessibilityLabel?: string;
};

const COLORS = {
  porcini: '#8B5E3C',
  finferli: '#C9901A',
};

export function MushroomMarkerBadge({
  species,
  count,
  label,
  porciniCount,
  finferliCount,
  accessibilityLabel,
}: Props) {
  const mixed = species === 'mixed';
  const spokenLabel = accessibilityLabel ?? (mixed
    ? `${porciniCount} porcini e ${finferliCount} finferli`
    : `${count} ${species}`);

  return (
    <View
      collapsable={false}
      accessible
      accessibilityRole="image"
      accessibilityLabel={spokenLabel}
      style={[
        styles.marker,
        count > 1 && styles.markerMultiple,
        !mixed && { backgroundColor: COLORS[species] },
      ]}
    >
      {mixed && (
        <View pointerEvents="none" style={styles.mixedFill}>
          <View style={{ flex: 1, backgroundColor: COLORS.porcini }} />
          <View style={{ flex: 1, backgroundColor: COLORS.finferli }} />
        </View>
      )}
      <Text style={[styles.text, species === 'finferli' && styles.textDark]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  marker: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  markerMultiple: {
    minWidth: 30,
    width: 'auto',
    paddingHorizontal: 5,
  },
  mixedFill: {
    ...StyleSheet.absoluteFillObject,
    flexDirection: 'row',
  },
  text: {
    color: '#fff',
    fontSize: 10,
    lineHeight: 12,
    fontWeight: '900',
    textShadowColor: 'rgba(0,0,0,0.75)',
    textShadowRadius: 1,
    textShadowOffset: { width: 0, height: 1 },
  },
  textDark: {
    color: '#111',
    textShadowColor: 'transparent',
  },
});

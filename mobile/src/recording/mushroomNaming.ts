export type RecordingMushroomMarker = {
  tipo: 'Porcino' | 'Finferlo';
  name: string;
};

export function nextMushroomMarkerName(
  species: RecordingMushroomMarker['tipo'],
  existing: readonly RecordingMushroomMarker[],
): string {
  const prefix = species === 'Porcino' ? 'porcino' : 'finferlo';
  const sameSpecies = existing.filter((marker) => marker.tipo === species);
  const greatestExistingNumber = sameSpecies.reduce((greatest, marker) => {
    const match = marker.name.toLocaleLowerCase('it-IT').match(new RegExp(`^${prefix}(\\d+)$`));
    return match ? Math.max(greatest, Number(match[1])) : greatest;
  }, 0);
  return `${prefix}${Math.max(sameSpecies.length, greatestExistingNumber) + 1}`;
}

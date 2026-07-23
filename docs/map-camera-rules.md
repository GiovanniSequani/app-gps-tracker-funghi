# Map Camera Rules

These rules document the MapLibre/GPS regressions that were fixed in the mobile app. Read this before changing `mobile/App.tsx`, `mobile/IndiceScreen.tsx`, `mobile/IndiceLayers.tsx`, or any map/index/location code.

## Invariants

- Index controls must never move the map.
- Changing index species, date, version, or opacity must update only the index layer state.
- The quick index panel must not call camera commands, reset map state, remount the map, or trigger GPS centering.
- The `Indice` tab must use the same index state as the quick panel, without adding camera side effects.
- GPS updates after the first position must update location/path data only.
- Recording must not automatically follow the current GPS position.
- The map may center only from explicit camera actions: initial app position, center button, or tapping a loaded route.

## What Caused The Regressions

Several broken versions mixed UI state, GPS state, and camera commands too tightly.

Bad patterns that caused recentering or invisible layers:

- Storing index state in a separate mutable external store that did not emit stable snapshots. This made quick panel and `Indice` tab controls visually stale or inconsistent.
- Making quick panel interactions update high-level app/map state in ways that recreated the map screen.
- Running camera commands from index state changes, or trying to preserve viewport by issuing camera commands around every index change.
- Keeping delayed/replayed camera commands with `setTimeout`. Those commands could execute later and move the map to an old GPS position.
- Using GPS updates as implicit camera updates while recording.
- Mounting/unmounting MapLibre `Camera` in unstable ways that interfered with native layer rendering. In the broken state, tiles, saved routes, current track, and the blue location dot disappeared together.

## Current Safe Shape

The stable shape is:

- `App` owns the index state directly: `activeLayer`, `tileDate`, `tileVersion`, `tileOpacity`.
- The quick panel and `IndiceScreen` receive direct setters for those fields.
- `MemoMapCanvas` renders the map and layers.
- The quick panel is a UI overlay only.
- The index layer is rendered through `IndiceLayerTiles`; changing its props must not call camera logic.
- Camera movement goes through a narrow explicit path, currently `runCameraCommand`.
- `followLocationRef` is disabled when the user moves the map.

## Camera Rules

Do not call `runCameraCommand` from:

- index species changes;
- tile date/version changes;
- opacity changes;
- quick panel drag/collapse/open/close;
- `IndiceScreen` controls;
- `tilesLoading` or tile discovery effects;
- ordinary foreground GPS updates;
- route/path state updates while recording.

It is acceptable to call `runCameraCommand` only from:

- initial app positioning after the first foreground position is obtained;
- the center button;
- tapping a saved route in the "IN MAPPA" panel.

If a future change needs another camera command, add a comment explaining why it is an explicit user action or one-time initialization.

## GPS Rules

- Do not cache and render old GPS positions as the current position on app start.
- Do not center repeatedly on `watchPositionAsync` updates.
- Do not center repeatedly from background tracking file polling.
- During recording, append/update the path and blue dot, but do not follow the user automatically.
- If foreground location watching is reintroduced for the blue dot, it must not call `runCameraCommand` except for a guarded first-fix flow.

## MapLibre Layer Rules

- Treat disappearance of index tiles, saved routes, current track, and blue dot together as a MapLibre tree/camera stability issue first.
- Keep `MapView` mounted independently from quick panel state.
- Avoid changing `MapView` keys in response to index state.
- Avoid remounting the entire map to refresh tiles.
- To refresh index tiles, change only `IndiceLayerTiles` props or source/layer keys.

## Checklist Before Editing Map/GPS

- Does this change call `runCameraCommand` from anything other than initial position, center button, or saved-route tap?
- Can a quick panel interaction cause `MapView` or `MemoMapCanvas` to remount?
- Can a GPS update after the first fix move the camera?
- Can recording cause automatic camera follow?
- Do index controls still update only index layer state?
- Do saved routes, current path, blue dot, and index tiles still render after changing index controls?

If any answer is uncertain, add temporary logs around `runCameraCommand` and index setters before changing behavior.

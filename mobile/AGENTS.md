# Mobile guidance

- This single Expo project targets both Android and iOS.
- Keep platform-specific behavior local with `Platform.select` or `.android` / `.ios` files; do not duplicate the application.
- Read `../docs/map-camera-rules.md` before changing map, GPS, index controls, or MapLibre layers.
- Run npm, Expo, and EAS commands from this directory.
- Keep backend credentials out of this directory. Only client-safe `EXPO_PUBLIC_*` values belong in the mobile environment.

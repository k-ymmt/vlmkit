# ios-sample — the fixture app for `vlmkit scan a11y ios:` and `scan scene ios:`

A UIKit screen ("Settings") and a SwiftUI screen ("Profile", pushed by "Open profile"), with
every accessibility and layout defect planted on purpose. `Sources/main.swift` lists them.

```bash
./build.sh                       # swiftc → build/VlmkitSample.app, installed on the booted simulator
vlmkit scan a11y ios:dev.vlmkit.sample --out a11y.json && vlmkit check a11y tree a11y.json
vlmkit scan scene ios:dev.vlmkit.sample --out scene.json && vlmkit check integrity --elements scene.json --image scene.png
```

No Xcode project: the app is `swiftc` on `Sources/*.swift` plus `Info.plist`, which is the
whole build and the whole reason it can be read in one sitting. `docs/ios-simulator.md` has
the mechanism; `packages/vlmkit-markup/src/ios/ios.test.ts` asserts every planted defect
against the dumps saved in `fixtures/ios-sample/`.

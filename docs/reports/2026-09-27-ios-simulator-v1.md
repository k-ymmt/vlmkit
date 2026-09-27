# iOS Simulator v1: vlmkit's gates on an app with no code of vlmkit's in it (2026-09-27)

**Ask.** Make vlmkit verifiable on the iOS Simulator using LLDB or runtime library injection,
so that an app needs no special code; implement while measuring, and prefer the better
mechanism when the measurements say so.

**Result.** `vlmkit scan a11y ios:<bundle-id>`, `vlmkit scan scene ios:<bundle-id>` and
`vlmkit snapshot ios:<bundle-id>` work on the booted simulator against any installed app. The
mechanism is a dylib injected at launch through `SIMCTL_CHILD_DYLD_INSERT_LIBRARIES`; LLDB was
measured and rejected. Every judge downstream is unchanged: the a11y tree is `vlmkit-a11y/1`,
the scene is the `--elements` contract. Guide: `docs/ios-simulator.md`.

## Mechanism bake-off

| candidate | measured | verdict |
|---|---|---|
| `lldb -p <pid>` on a simulator process | `error: attach failed: Not allowed to attach to process` on Apple's Settings app; only a build with `get-task-allow` attaches | rejected — covers the project's own debug build only, and a debugger holds the process |
| `SIMCTL_CHILD_DYLD_INSERT_LIBRARIES` | a 30-line probe dylib ran its constructor inside Apple's Messages app and wrote to the host's `/tmp` | chosen — any installed app, zero per-request cost |

The agent is one Objective-C file (`packages/vlmkit-markup/ios-agent/VlmkitAgent.m`), built
by `xcrun clang` on first use in about a second and cached by content; it serves a unix socket
(the simulator shares the host's filesystem). One request per connection, JSON lines.

## Three things the first dumps taught

1. **UIKit answers accessibility only when the device says a client exists.** The first dump
   had one accessibility element out of twenty-two. Setting
   `com.apple.Accessibility ApplicationAccessibilityEnabled` on the device (via `simctl spawn
   … defaults write`) loads the accessibility bundle at the next launch; measured that this
   one key suffices, `AccessibilityEnabled` and `AutomationEnabled` are not needed.
2. **A window that "responds to user interaction" is not a tap target.** Giving `tap` to
   anything with `accessibilityRespondsToUserInteraction` made the window the operable
   ancestor of every button, so `target-undersized` reported nothing and listed three
   "enclosed" targets instead. Only announced elements tap now.
3. **A hosting view's `accessibilityElements` replaces its subviews.** With subviews dumped
   first, the `UISwitch` under a SwiftUI `Toggle` appeared twice — once as the node "Dark mode",
   once as a nameless switch. The agent now dumps the announced list first and the host stops
   at it.

Two smaller ones: SF Symbols announce their own names ("Gear shape", "Trash"), so an
"unlabelled" fixture button has to draw its glyph; and Apple's `systemBlue` with white text is
3.5:1, which the fixture had to stop using so its planted contrast defect stayed the only one.

## Touch synthesis

`--tap` is a synthesized touch, not `accessibilityActivate`, because the ask was hit-testing.
The KIF technique (private `UITouch` setters, a digitizer `IOHIDEvent`, `_touchesEvent`,
`sendEvent:`) works on iOS 27.0: every selector exists (the agent's `methods` request lists a
class's real selectors, which is how the one wrong assumption — `_addTouch:forDelayedDelivery:`
lives on `UITouchesEvent`, not `UIEvent` — was found in a minute). Measured effects: a
`UIButton`'s action fires, a navigation push happens, a SwiftUI `Toggle` flips when the touch
lands on its switch.

That last one decided where a tap lands: the node "Dark mode" is the whole row, and a touch at
its centre toggles nothing (it is the label — a finger would do the same). The platform's
`accessibilityActivationPoint` is the switch, so `--tap` uses it when it lies inside the frame.

## What the scene needed that the a11y tree did not

`check integrity` on the first scene reported five things; two were the planted defects
(the truncated label, the log past the fold) and three were UIKit: a `UISwitch`'s 630pt
internal image view (protrusion), `_UIBarBackground` extending under the status bar
(62pt protrusion), and a text field's boundary "missing" because its edge is painted by a
private subview. Fixed in the converter, not the judges: controls are leaves, private chrome
is walked but not recorded, a bordered text field carries `outline: true`.

## Numbers

| | |
|---|---|
| agent source | 658 lines of Objective-C, no framework beyond UIKit / CoreGraphics / QuartzCore |
| agent build | ~1s, cached under `~/Library/Caches/vlmkit/ios-agent/` |
| `scan a11y ios:` end to end (relaunch, settle, dump, 3x screenshot) | ~5s |
| fixture build (`swiftc`, two screens) | ~5s, no Xcode project |
| fixture: nodes / named / operable | 25 / 21 / 11 (Settings), 9 / 7 / 6 (Profile) |
| planted defects found, false findings on the a11y tree | 9 of 9, 0 |
| tests (no simulator, saved dumps) | 9 in `packages/vlmkit-markup/src/ios/ios.test.ts` |

## Environment notes

Xcode 27.1 beta on macOS 27: `Simulator.app` is replaced by `DeviceHub.app`; a headless
`simctl boot` of iOS 26.5 never finished, iOS 27.0 through DeviceHub booted in under a
minute. This machine has no Playwright Chromium installed, so the browser-bound suites
(`snapshot-cli`, `json-contract`, the Flutter `a11y-tree` test) fail here for that reason and
were not touched.

## Next

- Flutter iOS and React Native fixtures through the same walk.
- `setText` and scrolling as steps; a `--tap` on `snapshot ios:`.
- A macOS CI job, once a runner's simulator boots headless for its Xcode.

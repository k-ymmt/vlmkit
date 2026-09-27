// The fixture app for `vlmkit scan a11y ios:dev.vlmkit.sample` and `scan scene`.
//
// Built with a bare `swiftc` call (see build.sh) — no Xcode project, no test target,
// no SDK of vlmkit's inside it. Every defect below is planted on purpose, so the
// tests can assert that the iOS collector reports each one and nothing else:
//
//   UIKit screen ("Settings")
//     "Seed hint"             low-contrast label (#BBBBBB on white)      → contrast-below-aa
//     the text field          no placeholder, no label                   → unlabelled-control
//     the circle button       drawn image, no accessibilityLabel (SF Symbols announce their names)          → unlabelled-control
//     "Info" 20x20            touching the 44pt "Add", so 2.5.8's spacing
//                             exception cannot excuse it                 → target-undersized
//     "Help" 20x20            4pt after "Info", room after it: excused   → wcagExempt
//     "Place here" 17pt       inside a 44pt operable row                 → enclosed
//     "Next"                  disabled: judged, listed as exempt for contrast
//     "log 1".."log 5"        past the fold, in a plain UIView that does not scroll
//                                                                        → unreachable-content
//     "Truncated line"        numberOfLines = 1 in a 200pt label         → text-clipped (scene)
//   SwiftUI screen ("Profile"), pushed by "Open profile"
//     the circle button       image only, no label (an SF Symbol would announce its own name)                       → unlabelled-control
//     "Tiny" 20x20            touching "Save"                            → target-undersized
import UIKit
import SwiftUI

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?
  func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
    guard let windowScene = scene as? UIWindowScene else { return }
    let window = UIWindow(windowScene: windowScene)
    window.rootViewController = UINavigationController(rootViewController: SettingsViewController())
    window.makeKeyAndVisible()
    self.window = window
  }
}

final class AppDelegate: UIResponder, UIApplicationDelegate {
  func application(_ application: UIApplication, configurationForConnecting session: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
    let config = UISceneConfiguration(name: "Default", sessionRole: session.role)
    config.delegateClass = SceneDelegate.self
    return config
  }
}

UIApplicationMain(CommandLine.argc, CommandLine.unsafeArgv, nil, NSStringFromClass(AppDelegate.self))

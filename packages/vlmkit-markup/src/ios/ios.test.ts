/**
 * The iOS collector, judged from its saved dumps: no simulator here. The dumps in
 * `fixtures/ios-sample/` were written by `scan a11y ios:dev.vlmkit.sample --dump` on the
 * fixture app (`examples/ios-sample/`, iPhone 17 / iOS 27.0, 2026-09-27); every defect the
 * app plants is asserted, and nothing else may be reported. Regenerate with:
 *
 *   examples/ios-sample/build.sh
 *   vlmkit scan a11y ios:dev.vlmkit.sample --out /tmp/a.json --frame fixtures/ios-sample/settings.png --dump fixtures/ios-sample/settings.dump.json
 *   vlmkit scan a11y ios:dev.vlmkit.sample --tap "Open profile" --out /tmp/p.json --frame fixtures/ios-sample/profile.png --dump fixtures/ios-sample/profile.dump.json
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "vitest";
import { parseA11yTree } from "@mizchi/vlmkit-judge/a11y-tree.ts";
import { judgeSceneIntegrity, parseSceneElements } from "@mizchi/vlmkit-judge/scene.ts";
import { runCheckA11yTree } from "../a11y-tree/check-a11y-tree.ts";
import { runScanA11y } from "../a11y-tree/scan-a11y.ts";
import { findTapTarget, iosDumpToA11yTree, iosDumpToScene, iosRole, parseIosDump, shortClass, tappableNames } from "./dump.ts";
import { downscaleFrame } from "./frame.ts";
import { runScanScene } from "./scan-scene.ts";

const ROOT = resolve(import.meta.dirname!, "../../../..");
const FIXTURES = join(ROOT, "fixtures/ios-sample");
const settings = () => parseIosDump(readFileSync(join(FIXTURES, "settings.dump.json"), "utf8"));
const profile = () => parseIosDump(readFileSync(join(FIXTURES, "profile.dump.json"), "utf8"));
const tmp = () => mkdtempSync(join(tmpdir(), "vlmkit-ios-"));

describe("iOS dump → vlmkit-a11y/1", () => {
  it("maps UIKit's answers onto the contract: roles from traits and classes, names, values, states, actions", () => {
    const tree = iosDumpToA11yTree(settings());
    assert.equal(tree.format, "vlmkit-a11y/1");
    assert.equal(tree.platform, "ios-simulator");
    assert.deepEqual(tree.viewport, { width: 402, height: 874 });
    assert.equal(tree.scale, 3);
    const byName = new Map(tree.nodes.map((n) => [n.name, n]));
    assert.equal(byName.get("Game options")!.role, "heading");
    assert.equal(byName.get("Seed hint")!.role, "text");
    assert.deepEqual(byName.get("Start")!.actions, ["tap"]);
    assert.equal(byName.get("Start")!.textSize, 17);
    assert.deepEqual(byName.get("Next")!.states, { disabled: true });
    assert.equal(byName.get("Notifications")!.role, "switch");
    assert.deepEqual(byName.get("Notifications")!.states, { checked: false });
    const field = tree.nodes.find((n) => n.role === "textfield")!;
    assert.equal(field.name, undefined);
    assert.equal(field.value, "1234");
    assert.ok(field.actions!.includes("setText"));
    // A window and a scroll view are containers, never tap targets: giving them `tap` made
    // every small button "enclosed" by the window and nothing was ever undersized.
    for (const n of tree.nodes) {
      if (n.role === "window" || n.role === "scrollview") assert.ok(!(n.actions ?? []).includes("tap"), n.path);
    }
    assert.ok(tree.nodes.some((n) => n.role === "scrollview" && n.actions?.includes("scroll")));
    // Row 1 is a container with its own label: no font of its own, so no declared size.
    assert.equal(byName.get("Row 1")!.textSize, undefined);
  });

  it("check a11y tree finds each planted defect on the Settings screen and nothing else", async () => {
    const dir = tmp();
    const out = join(dir, "a11y.json");
    const scan = await runScanA11y({ source: join(FIXTURES, "settings.dump.json"), out, frame: join(FIXTURES, "settings.png") });
    assert.equal(scan.platform, "ios-simulator");
    const tree = parseA11yTree(readFileSync(out, "utf8"));
    const report = await runCheckA11yTree({ source: out });
    assert.deepEqual(report.unlabelled.map((f) => f.role).sort(), ["button", "textfield"]);
    assert.equal(report.unreachable.length, 1);
    assert.equal(report.unreachable[0]!.first.name, "log 1");
    assert.equal(report.unreachable[0]!.count, 5);
    assert.deepEqual(report.contrast!.failures.map((f) => f.name), ["Seed hint"]);
    assert.ok(report.contrast!.failures[0]!.ratio < 2.5, String(report.contrast!.failures[0]!.ratio));
    assert.ok(report.contrast!.skipped.some((s) => s.name === "Next" && s.reason === "disabled"));
    assert.deepEqual(report.touch.failures.map((f) => f.text), ["Info"]);
    assert.deepEqual(report.touch.wcagExempt.map((f) => f.text), ["Help"]);
    assert.deepEqual(report.touch.enclosed.map((e) => [e.name, e.by.split(">").pop()]), [["Place here", "RowControl[0]"]]);
  }, 30000);

  it("a SwiftUI screen: the hosting view's announced nodes, the UIKit views it hosts once, not twice", async () => {
    const tree = iosDumpToA11yTree(profile());
    const names = tree.nodes.map((n) => n.name).filter(Boolean);
    assert.ok(names.includes("Profile") && names.includes("Dark mode") && names.includes("Save") && names.includes("Tiny"), names.join(","));
    assert.equal(tree.nodes.filter((n) => n.role === "switch").length, 1, "the UISwitch under the SwiftUI Toggle is announced as one node");
    assert.equal(tree.nodes.find((n) => n.role === "switch")!.name, "Dark mode");
    const field = tree.nodes.find((n) => n.role === "textfield")!;
    assert.equal(field.name, "Name"); // SwiftUI's placeholder names the field
    assert.equal(field.value, "Ada");
    const dir = tmp();
    const out = join(dir, "p.json");
    await runScanA11y({ source: join(FIXTURES, "profile.dump.json"), out, frame: join(FIXTURES, "profile.png") });
    const report = await runCheckA11yTree({ source: out });
    assert.deepEqual(report.unlabelled.map((f) => f.role), ["button"]); // the drawn-image button
    assert.deepEqual(report.touch.failures.map((f) => f.text), ["Tiny"]);
    assert.equal(report.contrast!.failures.length, 0, JSON.stringify(report.contrast!.failures));
  }, 30000);

  it("--tap resolves an exact name to the node's activation point, and names the alternatives", () => {
    const dump = settings();
    const tree = iosDumpToA11yTree(dump);
    const target = findTapTarget(dump, "Open profile")!;
    const node = tree.nodes.find((n) => n.name === "Open profile")!;
    assert.equal(target.path, node.path);
    assert.ok(target.operable);
    // UIKit's activation point for a plain button is its centre.
    assert.ok(Math.abs(target.x - (node.rect.left + node.rect.width / 2)) < 1 && Math.abs(target.y - (node.rect.top + node.rect.height / 2)) < 1, JSON.stringify(target));
    assert.equal(findTapTarget(dump, "Open profil"), null);
    assert.ok(tappableNames(dump).includes("Start"));
    assert.ok(!tappableNames(dump).includes("Seed hint"));
    // A SwiftUI Toggle announces its whole row; the tap lands on the switch at its right end.
    const toggle = findTapTarget(profile(), "Dark mode")!;
    const row = iosDumpToA11yTree(profile()).nodes.find((n) => n.name === "Dark mode")!;
    assert.ok(toggle.x > row.rect.left + row.rect.width * 0.75, JSON.stringify({ toggle, row: row.rect }));
  });

  it("class names read as paths: Swift-mangled hosting views, module prefixes", () => {
    assert.equal(shortClass("_TtGC7SwiftUI14_UIHostingViewV12VlmkitSample11ProfileView_"), "UIHostingView");
    assert.equal(shortClass("SwiftUI.AccessibilityNode"), "AccessibilityNode");
    assert.equal(shortClass("VlmkitSample.RowControl"), "RowControl");
    assert.equal(shortClass("_UIBarBackground"), "UIBarBackground");
    const sw = { kind: "view", cls: "UISwitch", ax: { element: true, label: "x", value: "0", hint: null, id: null, traits: ["button", "toggleButton"], frame: { x: 0, y: 0, w: 1, h: 1 }, hidden: false } } as const;
    assert.equal(iosRole(sw as never), "switch");
  });
});

describe("iOS dump → scene", () => {
  it("records painted views in points with text, measured extents, colours and fonts; controls are leaves; private chrome is not recorded", () => {
    const elements = iosDumpToScene(settings());
    const truncated = elements.find((e) => (e.text ?? "").startsWith("Truncated line"))!;
    assert.equal(truncated.tag, "label");
    assert.equal(truncated.width, 200);
    assert.ok(truncated.textMeasured!.width > 500, String(truncated.textMeasured!.width));
    assert.deepEqual(truncated.clip, { left: truncated.left, top: truncated.top, width: truncated.width, height: truncated.height });
    assert.equal(truncated.fontSize, 15);
    assert.equal(truncated.color, "rgba(0,0,0,1.000)");
    const start = elements.find((e) => e.text === "Start")!;
    assert.equal(start.tag, "button");
    assert.equal(start.role, "button");
    assert.equal(start.background, "rgba(0,84,204,1.000)");
    assert.equal(start.radius, 6);
    assert.equal(start.fontSize, 17);
    assert.ok(!elements.some((e) => e.classes === "UIButtonLabel"), "a button's label is the button's text, not a second element");
    assert.ok(!elements.some((e) => /^UISwitchModernVisualElement|_UIBarBackground|_UITouchPassthroughView/.test(e.classes ?? "")), "UIKit's insides and chrome");
    const field = elements.find((e) => e.role === "field")!;
    assert.equal(field.text, "1234");
    assert.equal(field.outline, true); // .roundedRect paints its own edge
    const seedHint = elements.find((e) => e.text === "Seed hint")!;
    assert.equal(seedHint.color, "rgba(187,187,187,1.000)");
    assert.equal(elements.find((e) => e.text === "Game options")!.heading, 2);
    assert.ok(elements.every((e) => e.width > 0 && e.height > 0));
  });

  it("check integrity on the scene: the truncated label and the log past the fold, not UIKit's chrome", async () => {
    const dir = tmp();
    const out = join(dir, "scene.json");
    const report = await runScanScene({ source: join(FIXTURES, "settings.dump.json"), out, frame: join(FIXTURES, "settings.png") });
    assert.equal(report.counts.text > 10, true);
    assert.equal(report.frame, join(dir, "scene.png"));
    const elements = parseSceneElements(readFileSync(out, "utf8"));
    const judged = judgeSceneIntegrity(elements, { viewport: 402 });
    const kinds = judged.findings.map((f) => `${f.kind}:${f.selector}`);
    assert.ok(kinds.some((k) => k.startsWith("text-clipped:") ), kinds.join("\n"));
    assert.ok(judged.findings.some((f) => f.kind === "container-protrusion" && /366px|vertical/.test(f.message)), "the log view past the fold");
    assert.ok(!judged.findings.some((f) => /_UIBarBackground|UISwitchModernVisualElement/.test(f.selector ?? "")), kinds.join("\n"));
    const lowContrast = judged.findings.filter((f) => f.kind === "low-contrast-text");
    assert.deepEqual(lowContrast.map((f) => /"([^"]+)"/.exec(f.message)?.[1]), ["Seed hint"]);
  }, 30000);

  it("a SwiftUI screen's nodes are text elements with rects and headings", () => {
    const elements = iosDumpToScene(profile());
    const heading = elements.find((e) => e.text === "Profile" && e.heading === 2)!;
    assert.ok(heading, elements.map((e) => e.text).filter(Boolean).join(","));
    assert.equal(heading.tag, "heading");
    assert.ok(elements.some((e) => e.text === "Save" && e.role === "button"));
  });

  it("boxes a 3x frame down to 1x", () => {
    const png = { width: 6, height: 3, data: new Uint8Array(6 * 3 * 4).fill(200) };
    for (let i = 0; i < 9; i++) png.data.set([0, 0, 0, 255], (Math.floor(i / 3) * 6 + (i % 3)) * 4);
    const out = downscaleFrame(png, 3);
    assert.deepEqual([out.width, out.height], [2, 1]);
    assert.deepEqual([...out.data.slice(0, 4)], [0, 0, 0, 255]);
    assert.deepEqual([...out.data.slice(4, 8)], [200, 200, 200, 200]);
  });
});

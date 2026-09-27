/**
 * The iOS agent's dump (`vlmkit-ios-dump/1`) as two contracts: a `vlmkit-a11y/1` tree for
 * `check a11y tree`, and a scene (`SceneElement[]`) for `check integrity / composition /
 * color / design / copy --elements`. Pure: the dump in, the file out; no simulator here.
 *
 * The dump is what `ios-agent/VlmkitAgent.m` writes from inside the app: every window's
 * view hierarchy (frames in screen points, colours, fonts, texts) with each view's
 * UIAccessibility answers, plus the accessibility elements a view announces that are not
 * views — SwiftUI's nodes, `UIAccessibilityElement`s. Both conversions walk that one tree.
 *
 * **What is announced vs what is painted** decides which conversion reads what:
 *
 * - The a11y tree takes the nodes UIKit says are accessibility elements (`ax.element`), the
 *   scroll views that make content reachable, and the windows. Roles come from traits and
 *   classes; a text field's name is its label or its placeholder, as the Android importer
 *   reads `hint`. Units are points, and `scale` carries the screen scale so contrast is
 *   measured on the 2x / 3x frame.
 * - The scene takes the painted views: hidden subtrees and zero-size views are skipped, and
 *   a UIKit control (`UISwitch`, `UITextField`, `UIButton`, …) is a leaf, because its private
 *   subviews are implementation — a `UISwitch` holds a 630pt-wide image view that would
 *   read as protrusion. A `UIButton`'s text is lifted from its title label so the button is
 *   one element with one text. SwiftUI's accessibility nodes join the scene as text-only
 *   elements: they are what a SwiftUI screen paints as text, and there is no view to read.
 */
import { UsageError } from "@mizchi/vlmkit-judge/errors.ts";
import { A11Y_TREE_FORMAT, type A11yNode, type A11yTree } from "@mizchi/vlmkit-judge/a11y-tree.ts";
import type { SceneElement } from "@mizchi/vlmkit-judge/scene.ts";

export const IOS_DUMP_FORMAT = "vlmkit-ios-dump/1";

export interface IosRect { x: number; y: number; w: number; h: number }

export interface IosAx {
  element: boolean;
  label: string | null;
  value: string | null;
  hint: string | null;
  id: string | null;
  traits: string[];
  traitsRaw?: number;
  frame: IosRect;
  /** `accessibilityActivationPoint`, screen points: where VoiceOver's double-tap lands. */
  activation?: { x: number; y: number };
  hidden: boolean;
  modal?: boolean;
  interactive?: boolean;
  customActions?: number;
  containerType?: number;
}

export interface IosFont { size: number; weight: number; name?: string }

export interface IosNode {
  kind: "view" | "ax";
  cls: string;
  frame?: IosRect;
  hidden?: boolean;
  alpha?: number;
  opaque?: boolean;
  clips?: boolean;
  interaction?: boolean;
  bg?: string | null;
  corner?: number;
  border?: number;
  borderColor?: string | null;
  shadow?: boolean;
  tag?: number;
  control?: { enabled: boolean; selected: boolean; highlighted: boolean };
  on?: boolean;
  sliderValue?: number;
  image?: IosRect | null;
  text?: string | null;
  placeholder?: string | null;
  font?: IosFont | null;
  textColor?: string | null;
  lines?: number;
  lineBreak?: number;
  textAlign?: number;
  textFits?: IosRect;
  textIntrinsic?: IosRect;
  title?: string | null;
  titleColor?: string | null;
  hasImage?: boolean;
  secure?: boolean;
  /** UITextBorderStyle: 0 none, 1 line, 2 bezel, 3 roundedRect. */
  borderStyle?: number;
  editable?: boolean;
  scroll?: { offset: { x: number; y: number }; content: { w: number; h: number }; scrollEnabled: boolean };
  ax: IosAx;
  children?: IosNode[];
  axElements?: IosNode[];
  windowLevel?: number;
  keyWindow?: boolean;
}

export interface IosDump {
  format: typeof IOS_DUMP_FORMAT;
  platform: string;
  app: { bundleId: string; process: string; pid: number; system: string };
  /** Points, in the screen's fixed (portrait) space; `scale` is frame pixels per point. */
  screen: { width: number; height: number; scale: number };
  windows: IosNode[];
}

// ---------------------------------------------------------------------------
// Reading

export function parseIosDump(source: string | unknown): IosDump {
  let raw: unknown = source;
  if (typeof source === "string") {
    try {
      raw = JSON.parse(source);
    } catch (error) {
      throw new UsageError(`not an iOS dump: ${(error as Error).message}`);
    }
  }
  const dump = raw as Partial<IosDump> | null;
  if (!dump || dump.format !== IOS_DUMP_FORMAT) {
    throw new UsageError(
      `not an iOS dump (format ${JSON.stringify(dump?.format ?? null)}; expected "${IOS_DUMP_FORMAT}").`
      + " Write one with: vlmkit scan a11y ios:<bundle-id> --dump dump.json",
    );
  }
  if (!dump.screen || !(dump.screen.width > 0) || !(dump.screen.height > 0) || !(dump.screen.scale > 0)) {
    throw new UsageError("iOS dump: `screen` needs a positive width, height and scale.");
  }
  if (!Array.isArray(dump.windows)) throw new UsageError("iOS dump: `windows` must be an array.");
  return dump as IosDump;
}

// ---------------------------------------------------------------------------
// Walking

/** One node with what the walk knows about its place. */
export interface IosVisit {
  node: IosNode;
  path: string;
  parent: IosVisit | null;
  depth: number;
  /** An ancestor is hidden, transparent or announced as hidden. */
  hiddenByAncestor: boolean;
  /** An ancestor is itself an accessibility element (UIKit hides its children from VoiceOver). */
  insideElement: boolean;
}

/** `SwiftUI.AccessibilityNode` → `AccessibilityNode`; `_TtGC7SwiftUI14_UIHostingViewV…` → `UIHostingView`. */
export function shortClass(cls: string): string {
  if (cls.startsWith("_Tt")) {
    // Length-prefixed identifiers: `7SwiftUI` `14_UIHostingView` `V` `12VlmkitSample` … — the
    // module first, then the type.
    const parts: string[] = [];
    for (let i = 3; i < cls.length;) {
      const m = /^\d+/.exec(cls.slice(i));
      if (!m) { i++; continue; }
      const n = Number(m[0]);
      parts.push(cls.slice(i + m[0].length, i + m[0].length + n));
      i += m[0].length + n;
    }
    const type = parts[1] ?? parts[0];
    if (type) return type.replace(/^_+/, "").replace(/_+$/, "");
  }
  return cls.slice(cls.lastIndexOf(".") + 1).replace(/^_+/, "");
}

const isInvisible = (n: IosNode): boolean => n.kind === "view" && (n.hidden === true || n.alpha === 0);

/**
 * Depth-first, in tree order: what a view announces (`axElements`) before its remaining
 * subviews, as the agent dumps them. The visitor returns `false` to skip the whole subtree,
 * `"announced"` to walk only the announced elements — what VoiceOver does when a view sets
 * `accessibilityElements`, so a UISwitch hosted by SwiftUI is not a second, nameless switch.
 */
export function walkIosDump(dump: IosDump, visit: (v: IosVisit) => boolean | "announced" | void): void {
  const seenPaths = new Set<string>();
  const walk = (node: IosNode, parent: IosVisit | null, index: Map<string, number>): void => {
    const name = shortClass(node.cls);
    const i = index.get(name) ?? 0;
    index.set(name, i + 1);
    let path = `${parent ? `${parent.path}>` : ""}${name}[${i}]`;
    while (seenPaths.has(path)) path += "'";
    seenPaths.add(path);
    const v: IosVisit = {
      node,
      path,
      parent,
      depth: parent ? parent.depth + 1 : 0,
      hiddenByAncestor: parent ? parent.hiddenByAncestor || isInvisible(parent.node) || parent.node.ax.hidden : false,
      insideElement: parent ? parent.insideElement || parent.node.ax.element : false,
    };
    const verdict = visit(v);
    if (verdict === false) return;
    const childIndex = new Map<string, number>();
    for (const c of node.axElements ?? []) walk(c, v, childIndex);
    if (verdict === "announced") return;
    for (const c of node.children ?? []) walk(c, v, childIndex);
  };
  const rootIndex = new Map<string, number>();
  for (const w of dump.windows) walk(w, null, rootIndex);
}

const rectOf = (r: IosRect | undefined): { left: number; top: number; width: number; height: number } =>
  ({ left: r?.x ?? 0, top: r?.y ?? 0, width: r?.w ?? 0, height: r?.h ?? 0 });

const hasTrait = (n: IosNode, t: string): boolean => n.ax.traits.includes(t);
const isUIKitClass = (cls: string): boolean => /^(UI|_UI|SwiftUI\.UIKit)/.test(cls);
const isScrollClass = (cls: string): boolean => /^(UIScrollView|UITableView|UICollectionView|UITextView|WKWebView)$/.test(shortClass(cls))
  || /ScrollView$|TableView$|CollectionView$/.test(shortClass(cls));
const isTextFieldClass = (cls: string): boolean => /^(UITextField|UISearchTextField|SwiftUI\.UIKitTextField)$/.test(cls) || /TextField$/.test(shortClass(cls));

/** The node's own font, or a button's title-label font. A container reports none: a row named
 * "Row 1" that holds a 9pt button is not 9pt text, and the judge measures the frame instead. */
function fontOf(n: IosNode): IosFont | null {
  if (n.font) return n.font;
  if (n.cls === "UIButton") return titleLabelOf(n)?.font ?? null;
  return null;
}

/** The label view inside a UIButton, whose measured text extent says whether the title fits. */
const titleLabelOf = (n: IosNode): IosNode | undefined => (n.children ?? []).find((c) => c.cls === "UIButtonLabel" || (c.cls === "UILabel" && c.text));

// ---------------------------------------------------------------------------
// vlmkit-a11y/1

export interface IosA11yOptions {
  /** The screenshot, relative to where the tree will be written. */
  frame?: string;
}

/** Role from traits first (the platform's word), then the class (the kind of control). */
export function iosRole(n: IosNode): string {
  const cls = n.cls;
  if (n.kind === "view" && cls === "UIWindow") return "window";
  if (hasTrait(n, "searchField") || isTextFieldClass(cls) || (cls === "UITextView" && n.editable !== false)) return "textfield";
  if (cls === "UISwitch" || hasTrait(n, "toggleButton")) return "switch";
  if (cls === "UISlider" || cls === "UIStepper" || hasTrait(n, "adjustable")) return "slider";
  if (hasTrait(n, "link")) return "link";
  if (hasTrait(n, "header")) return "heading";
  if (hasTrait(n, "tabBar")) return "group";
  if (hasTrait(n, "button") || hasTrait(n, "keyboardKey")) return /UITabBarButton|TabBarItem/.test(cls) ? "tab" : "button";
  if (hasTrait(n, "image") || cls === "UIImageView") return "image";
  if (hasTrait(n, "staticText") || cls === "UILabel") return "text";
  if (/UITableViewCell$|UICollectionViewCell$/.test(cls)) return "listitem";
  if (/^(UITableView|UICollectionView)$/.test(cls)) return "list";
  if (n.kind === "view" && isScrollClass(cls)) return "scrollview";
  if (/UIAlertController|UIAlertView|Dialog|Alert/.test(cls) || n.ax.modal) return "dialog";
  if (n.ax.element && (n.ax.interactive || n.control?.enabled)) return "button";
  if (n.ax.element && n.ax.label) return "text";
  return "group";
}

/**
 * Only an announced element taps. A window or a scroll view answers
 * `accessibilityRespondsToUserInteraction` too, and giving it `tap` made it the operable
 * ancestor of every small button, so nothing was ever undersized.
 */
function isOperable(n: IosNode): boolean {
  const disabled = hasTrait(n, "notEnabled") || n.control?.enabled === false;
  const announced = n.ax.element || n.kind === "ax";
  return announced && !disabled && (n.ax.interactive === true || hasTrait(n, "button") || hasTrait(n, "link")
    || hasTrait(n, "keyboardKey") || hasTrait(n, "toggleButton") || (n.control?.enabled === true && n.interaction !== false));
}

/** Convert a dump to a tree: elements, scroll containers and windows, in tree order. */
export function iosDumpToA11yTree(dump: IosDump, options: IosA11yOptions = {}): A11yTree {
  const nodes: A11yNode[] = [];
  walkIosDump(dump, (v) => {
    const n = v.node;
    if (isInvisible(n)) return false;
    const role = iosRole(n);
    const scrolls = n.kind === "view" && isScrollClass(n.cls) && n.scroll?.scrollEnabled !== false;
    const include = n.ax.element || scrolls || role === "window" || (n.kind === "ax" && (n.ax.label || n.ax.interactive));
    // A view that lists its accessibility elements announces those and nothing else under it.
    const descend = (n.axElements?.length ?? 0) > 0 ? "announced" : undefined;
    if (!include) return descend;
    const label = (n.ax.label ?? "").trim();
    const name = role === "textfield" ? label || (n.placeholder ?? "").trim() : label;
    const rect = n.ax.element ? rectOf(n.ax.frame) : rectOf(n.frame);
    const disabled = hasTrait(n, "notEnabled") || n.control?.enabled === false;
    const operable = isOperable(n);
    const actions = [
      ...(operable && role !== "textfield" ? ["tap"] : []),
      ...(role === "textfield" && !disabled ? ["setText", "tap"] : []),
      ...(scrolls ? ["scroll"] : []),
      ...(role === "slider" && !disabled ? ["adjust"] : []),
    ];
    const value = n.ax.value ?? (n.kind === "view" && role === "textfield" ? n.text ?? undefined : undefined);
    const states: NonNullable<A11yNode["states"]> = {
      ...(disabled ? { disabled: true } : {}),
      ...(hasTrait(n, "selected") || n.control?.selected ? { selected: true } : {}),
      ...(role === "switch" ? { checked: n.on ?? value === "1" } : {}),
      ...(n.ax.hidden || v.hiddenByAncestor ? { hidden: true } : {}),
    };
    const font = fontOf(n);
    nodes.push({
      path: v.path,
      role,
      ...(name ? { name } : {}),
      ...(value && role !== "switch" && !n.secure ? { value: String(value) } : {}),
      rect,
      ...(Object.keys(states).length > 0 ? { states } : {}),
      ...(actions.length > 0 ? { actions } : {}),
      ...(font && (role === "text" || role === "heading" || role === "button" || role === "link" || role === "textfield")
        ? { textSize: font.size, fontWeight: font.weight }
        : {}),
    });
    return descend;
  });
  return {
    format: A11Y_TREE_FORMAT,
    platform: dump.platform || "ios-simulator",
    viewport: { width: dump.screen.width, height: dump.screen.height },
    scale: dump.screen.scale,
    ...(options.frame ? { frame: options.frame } : {}),
    nodes,
  };
}

// ---------------------------------------------------------------------------
// Scene

const TAGS: Array<[RegExp, string]> = [
  [/^UIWindow$/, "window"],
  [/^UILabel$|^UIButtonLabel$/, "label"],
  [/^UIButton$/, "button"],
  [/^(UITextField|UISearchTextField)$|TextField$/, "input"],
  [/^UITextView$/, "textarea"],
  [/^UIImageView$/, "img"],
  [/^UISwitch$/, "switch"],
  [/^UISlider$/, "slider"],
  [/^UISegmentedControl$/, "segmented"],
  [/^(UITableView|UICollectionView)$/, "list"],
  [/^(UITableViewCell|UICollectionViewCell)$/, "cell"],
  [/ScrollView$/, "scrollview"],
  [/^UIStackView$/, "stack"],
  [/^UINavigationBar$/, "nav"],
  [/^UITabBar$/, "tabbar"],
  [/^UIToolbar$/, "toolbar"],
  [/HostingView/, "hosting"],
];

export function sceneTag(n: IosNode): string {
  if (n.kind === "ax") {
    if (hasTrait(n, "header")) return "heading";
    if (hasTrait(n, "button") || hasTrait(n, "toggleButton")) return "button";
    if (hasTrait(n, "link")) return "link";
    if (hasTrait(n, "image")) return "img";
    return "text";
  }
  const short = shortClass(n.cls);
  return TAGS.find(([re]) => re.test(short) || re.test(n.cls))?.[1] ?? "view";
}

const opaqueColor = (c: string | null | undefined): string | undefined => {
  if (!c) return undefined;
  const m = /rgba\((\d+),(\d+),(\d+),([\d.]+)\)/.exec(c);
  if (m && Number(m[4]) === 0) return undefined;
  return c;
};

/** A UIKit control is a leaf: its subviews are implementation, not content. */
const isLeafControl = (n: IosNode): boolean =>
  n.kind === "view" && n.control !== undefined && isUIKitClass(n.cls) && !/^UIControl$/.test(n.cls);

/**
 * UIKit's private chrome (`_UIBarBackground`, `_UITouchPassthroughView`, …) is not a
 * component of the app: a bar background that extends under the status bar read as a 62pt
 * protrusion. Private views are not recorded; their subtrees are still walked, because a
 * navigation title label lives under `_UINavigationBarHostedViewContainer` — except the
 * ones that only ever hold chrome.
 */
const isPrivateChrome = (n: IosNode): boolean => n.kind === "view" && /^_/.test(n.cls.slice(n.cls.lastIndexOf(".") + 1));
const CHROME_SUBTREE = /ScrollIndicator|PointerInteraction|Passthrough|BarBackground|ScrollEdgeEffect|Backdrop|DropShadow/;

/** Convert a dump to the scene the style and integrity gates read. Points; the frame at 1x. */
export function iosDumpToScene(dump: IosDump): SceneElement[] {
  const out: SceneElement[] = [];
  let windowIndex = 0;
  walkIosDump(dump, (v) => {
    const n = v.node;
    if (isInvisible(n)) return false;
    if (n.kind === "view") {
      const r = rectOf(n.frame);
      if (r.width <= 0 || r.height <= 0) return false;
      if (v.depth === 0) windowIndex++;
      if (isPrivateChrome(n)) return !CHROME_SUBTREE.test(n.cls);
      const tag = sceneTag(n);
      const element: SceneElement = {
        path: v.path,
        tag,
        classes: n.cls,
        ...(n.ax.id ? { id: n.ax.id } : {}),
        ...r,
      };
      if (n.alpha !== undefined && n.alpha < 1) element.opacity = n.alpha;
      const bg = opaqueColor(n.bg);
      if (bg) element.background = bg;
      if (n.border && n.border > 0) {
        element.border = n.border;
        const bc = opaqueColor(n.borderColor);
        if (bc) element.borderColor = bc;
      }
      if (n.corner && n.corner > 0) element.radius = n.corner;
      if (n.shadow) element.shadow = true;
      if (windowIndex > 1) element.overlay = true;
      if (n.ax.hidden || v.hiddenByAncestor) element.ariaHidden = true;
      if (hasTrait(n, "header")) element.heading = 2;

      // Text: the node's own, or a button's title.
      let text = n.text ?? null;
      let font = n.font ?? null;
      let color = n.textColor ?? null;
      let measured: IosRect | undefined;
      let single = n.lines === 1;
      if (n.cls === "UIButton") {
        const label = titleLabelOf(n);
        text = n.title ?? label?.text ?? null;
        font = label?.font ?? null;
        color = n.titleColor ?? label?.textColor ?? null;
        measured = label?.textIntrinsic;
        single = true;
        if (label && text && measured && label.frame && measured.w > label.frame.w + 0.5) {
          element.clip = rectOf(label.frame);
        }
      } else if (n.text !== undefined) {
        measured = single ? n.textIntrinsic : n.textFits;
        if (tag === "input" && !text) text = n.placeholder ?? null;
        if (tag === "label" && text && measured && (measured.w > r.width + 0.5 || measured.h > r.height + 0.5)) {
          element.clip = { ...r };
        }
      }
      if (text) {
        element.text = text;
        if (measured) element.textMeasured = { width: measured.w, height: measured.h };
      }
      if (font) {
        element.fontSize = font.size;
        element.fontWeight = font.weight;
      }
      const ink = opaqueColor(color);
      if (ink) element.color = ink;
      if (n.control?.enabled === false || hasTrait(n, "notEnabled")) element.disabled = true;

      if (tag === "input" || tag === "textarea") {
        element.role = "field";
        // UIKit paints the edge of a .roundedRect / .bezel / .line field itself, inside a
        // private subview this walk does not record: the boundary exists, its colour is
        // the platform's. `outline` says so without claiming a colour.
        if (n.borderStyle !== undefined && n.borderStyle > 0) element.outline = true;
      }
      else if (hasTrait(n, "link")) element.role = "link";
      else if (n.control || hasTrait(n, "button")) element.role = "button";

      out.push(element);
      return !isLeafControl(n);
    }
    // An accessibility node with no view: SwiftUI's text, buttons, headers.
    const r = rectOf(n.ax.frame);
    if (r.width <= 0 || r.height <= 0) return;
    const tag = sceneTag(n);
    const element: SceneElement = { path: v.path, tag, classes: n.cls, ...(n.ax.id ? { id: n.ax.id } : {}), ...r };
    const label = (n.ax.label ?? "").trim();
    if (label) element.text = label;
    if (hasTrait(n, "header")) element.heading = 2;
    if (hasTrait(n, "notEnabled")) element.disabled = true;
    if (n.ax.hidden || v.hiddenByAncestor) element.ariaHidden = true;
    if (tag === "button") element.role = "button";
    else if (tag === "link") element.role = "link";
    out.push(element);
  });
  return out;
}

// ---------------------------------------------------------------------------
// Tapping

export interface TapTarget { name: string; path: string; x: number; y: number; operable: boolean }

/**
 * Every named, announced node with the point a tap on it lands on: the platform's
 * `accessibilityActivationPoint` when it lies inside the node's frame (a SwiftUI Toggle's
 * row announces "Dark mode", and its activation point is the switch — the row's centre is
 * the label, which a finger toggles nothing with), else the frame's centre.
 */
export function tapTargets(dump: IosDump): TapTarget[] {
  const out: TapTarget[] = [];
  walkIosDump(dump, (v) => {
    const n = v.node;
    if (isInvisible(n)) return false;
    const name = (n.ax.label ?? "").trim();
    const announced = n.ax.element || n.kind === "ax";
    if (!announced || !name || n.ax.hidden || v.hiddenByAncestor) return (n.axElements?.length ?? 0) > 0 ? "announced" : undefined;
    const r = n.ax.frame;
    const a = n.ax.activation;
    const inside = a && a.x >= r.x && a.x <= r.x + r.w && a.y >= r.y && a.y <= r.y + r.h;
    out.push({
      name,
      path: v.path,
      x: inside ? a.x : r.x + r.w / 2,
      y: inside ? a.y : r.y + r.h / 2,
      operable: isOperable(n),
    });
    return (n.axElements?.length ?? 0) > 0 ? "announced" : undefined;
  });
  return out;
}

/** Where `--tap <name>` lands: the first operable node with that exact name, else any named one. */
export function findTapTarget(dump: IosDump, name: string): TapTarget | null {
  const targets = tapTargets(dump);
  return targets.find((t) => t.operable && t.name === name) ?? targets.find((t) => t.name === name) ?? null;
}

/** Names a `--tap` could have used, for the error that says what it missed. */
export function tappableNames(dump: IosDump): string[] {
  return [...new Set(tapTargets(dump).filter((t) => t.operable).map((t) => t.name))];
}

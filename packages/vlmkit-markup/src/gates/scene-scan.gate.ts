/**
 * `scan scene` as a gate definition: a scene and its frame from a platform with no DOM,
 * for the gates that take `--elements`. Measurement lives in `../ios/`.
 *
 * A `scan` like `scan style`: an inventory first. Its one verdict is `scene-empty`, because a
 * scene with no text — an app captured before its first screen, or a dump of a launch
 * screen — passes every gate downstream for the wrong reason.
 */
import { readAll, readFlag, readInt } from "@mizchi/vlmkit-core/arg-reader.ts";
import { defineGate } from "@mizchi/vlmkit-core/plugin/contract.ts";
import type { Finding, RuleView } from "@mizchi/vlmkit-core/plugin/contract.ts";
import { tierIssues } from "@mizchi/vlmkit-core/plugin/rule-prose.ts";
import { firstPositional } from "@mizchi/vlmkit-core/plugin/args.ts";
import { BOLD, CYAN, DIM, RESET, YELLOW } from "@mizchi/vlmkit-core/terminal-colors.ts";
import { DEFAULT_SCENE, runScanScene, type ScanSceneOptions, type ScanSceneReport } from "../ios/scan-scene.ts";

const sceneEmpty = (report: ScanSceneReport): string | null =>
  report.counts.text === 0
    ? `the scene holds ${report.counts.elements} element(s) and none carries text — every gate reading it would judge nothing and pass.`
    : null;

function findings(report: ScanSceneReport): Finding[] {
  const empty = sceneEmpty(report);
  return empty ? [{ rule: "scene-empty", severity: "suspect", message: empty }] : [];
}

function format(report: ScanSceneReport, rules?: RuleView): string {
  const rows = findings(report).map((f) => ({ kind: f.rule, severity: f.severity, message: f.message }));
  const { shown, note } = tierIssues(rows, rules);
  const image = report.frame ? ` --image ${report.frame}` : "";
  return [
    "",
    `${BOLD}${CYAN}vlmkit scan scene${RESET}  ${DIM}${report.platform}${report.device ? `, ${report.device}` : ""}${RESET}`,
    `${DIM}source: ${report.source}${report.taps.length ? ` → ${report.taps.map((t) => JSON.stringify(t)).join(" → ")}` : ""}${RESET}`,
    ...report.notes.map((n) => `${DIM}  ${n}${RESET}`),
    "",
    `scene: ${report.out}  (${report.viewport.width}x${report.viewport.height} pt, frame at ${report.scale}x boxed to 1x)`,
    `frame: ${report.frame ?? `${DIM}none — ink and pixel rules will not run (pass --frame)${RESET}`}`,
    `  ${report.counts.elements} element(s), ${report.counts.text} with text, ${report.counts.fields} field(s), ${report.counts.buttons} button(s)`,
    ...shown.map(({ row, tier }) => `\n${YELLOW}! [${row.kind}]${tier === row.severity ? "" : ` (re-tuned to ${tier})`} ${row.message}${RESET}`),
    ...(note ? [`${DIM}${note}${RESET}`] : []),
    "",
    `${DIM}judge it without a simulator:${RESET}`,
    `  vlmkit check integrity --elements ${report.out}${image}`,
    `  vlmkit check composition --elements ${report.out} --viewport ${report.viewport.width}`,
    `  vlmkit check color --elements ${report.out}`,
    `  vlmkit check design --elements ${report.out}`,
    `  vlmkit check copy --elements ${report.out}${image} --manifest copy.txt`,
    "",
  ].join("\n");
}

export const sceneScanGate = defineGate<ScanSceneReport, ScanSceneOptions>({
  id: "scan.scene",
  command: ["scan", "scene"],
  title: "Scene snapshot (iOS Simulator)",
  summary: "Write a scene (--elements JSON) and its frame from an app with no DOM, for the style and integrity gates",
  category: "correctness",
  usage: `Collects the painted view hierarchy of an app as the scene contract
(docs/cli-reference.md: --elements) plus the frame at 1x, so check integrity,
composition, color, design and copy judge it with no simulator:

  iOS Simulator (the app is relaunched with vlmkit's agent injected — no code
  of vlmkit's in the app, no test target; docs/ios-simulator.md)
    vlmkit scan scene ios:dev.vlmkit.sample --out scene.json
    vlmkit scan scene ios:dev.vlmkit.sample --tap "Open profile" --out profile.json
    vlmkit check integrity --elements scene.json --image scene.png

  A saved dump (from --dump, no simulator needed)
    vlmkit scan scene dump.json --frame frame.png --out scene.json

Units are points; the screenshot (2x / 3x) is boxed down to 1x beside the
scene so every gate reads it at 1:1. Accessibility answers (labels, traits)
go to \`scan a11y ios:<bundle-id>\`; this scan reads paint.`,
  rules: [
    {
      id: "scene-empty",
      title: "The scene carries no text, so nothing downstream can judge it",
      severity: "suspect",
      docs: "An app captured before its first screen, or a launch screen, reads as an empty scene that passes every rule.",
    },
  ],
  inputs: [
    { name: "source", placeholder: "ios:<bundle-id>|dump.json", kind: "path", description: "App on the booted simulator, or a saved dump", positional: 0, required: true },
    { name: "out", placeholder: "file", kind: "path", description: "Scene file to write", defaultDescription: DEFAULT_SCENE },
    { name: "frame", placeholder: "frame.png", kind: "path", description: "iOS: where to write the 1x frame. Dump: the screenshot taken with it", defaultDescription: "beside --out" },
    { name: "device", placeholder: "booted|udid|name", kind: "string", description: "Simulator to use", defaultDescription: "booted" },
    { name: "tap", placeholder: "name", kind: "string", repeatable: true, description: "Tap a node by its exact accessible name before collecting (synthesized touch, hit-tested)" },
    { name: "dump", placeholder: "file", kind: "path", description: "Also write the raw agent dump (a fixture that needs no simulator)" },
    { name: "timeout", placeholder: "ms", kind: "number", description: "Launch / settle timeout", defaultDescription: "30000" },
  ],
  parse: (argv) => {
    const source = firstPositional(argv, "vlmkit scan scene <ios:bundle-id|dump.json> [--out scene.json]", [
      "--out", "--frame", "--device", "--tap", "--dump", "--timeout",
    ]);
    const frame = readFlag(argv, "frame");
    const device = readFlag(argv, "device");
    const dump = readFlag(argv, "dump");
    const taps = readAll(argv, "tap");
    const timeout = readInt(argv, "timeout");
    return {
      source,
      out: readFlag(argv, "out") ?? DEFAULT_SCENE,
      ...(frame ? { frame } : {}),
      ...(device ? { device } : {}),
      ...(dump ? { dump } : {}),
      ...(taps.length > 0 ? { taps } : {}),
      ...(timeout !== undefined ? { timeout } : {}),
    };
  },
  run: (options) => runScanScene(options),
  findings,
  format,
  headline: (report) => `${report.platform} scene ${report.out}: ${report.counts.elements} element(s), ${report.counts.text} with text`,
  ledger: (report) => ({
    tool: "scan-scene",
    source: report.source,
    headline: { platform: report.platform, out: report.out, ...report.counts },
  }),
});

/**
 * `vlmkit snapshot ios:<bundle-id>`: the baseline / diff loop of `snapshot`, with the iOS
 * Simulator's screenshot in place of a browser page. One "viewport" per run — the booted
 * device and its runtime — so a baseline taken on an iPhone 17 / iOS 27 is never compared
 * with an iPhone SE's frame.
 *
 * The app is relaunched with the agent (`@mizchi/vlmkit-markup/ios/capture-ios.ts`) so the
 * shot is taken once the screen has settled rather than after a guessed sleep, and `--tap`
 * is not offered here: a state to snapshot is reached with `scan a11y --tap`'s dump, or by
 * the app's own launch arguments.
 */
import { access, copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { compareScreenshots, generateDiffReport } from "@mizchi/vlmkit-core/heatmap.ts";
import { BOLD, CYAN, DIM, GREEN, RED, RESET, YELLOW, hr } from "@mizchi/vlmkit-core/terminal-colors.ts";
import { appendRunLedger } from "@mizchi/vlmkit-core/run-ledger.ts";
import type { VrtSnapshot } from "@mizchi/vlmkit-core/types.ts";
import { bundleIdOf, captureIos, isIosSource } from "@mizchi/vlmkit-markup/ios/capture-ios.ts";
import { determineSnapshotExitCode } from "../../cli/commands/snapshot.ts";

export { isIosSource };

export interface IosSnapshotOptions {
  sources: string[];
  labels: string[];
  outputDir: string;
  threshold: number;
  failOnDiff: boolean;
  failOnNewBaseline: boolean;
  maxDiffRatio?: number;
  configPath?: string;
  device?: string;
}

export interface IosSnapshotResult {
  url: string;
  label: string;
  viewport: string;
  screenshotPath: string;
  baselinePath?: string;
  diffRatio?: number;
  isNew: boolean;
  globalShift?: number;
  compensatedDiffRatio?: number;
  shiftOnly?: boolean;
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export async function runIosSnapshot(options: IosSnapshotOptions): Promise<number> {
  const { outputDir } = options;
  await mkdir(outputDir, { recursive: true });
  console.log();
  console.log(`${BOLD}${CYAN}╔════════════════════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}${CYAN}║  VRT Snapshot (iOS Simulator)                                        ║${RESET}`);
  console.log(`${BOLD}${CYAN}╚════════════════════════════════════════════════════════════════════════╝${RESET}`);
  console.log(`  ${DIM}Apps: ${options.sources.length} | Device: ${options.device ?? "booted"} | Output: ${outputDir}${RESET}`);
  console.log(`  ${DIM}Threshold: ${options.threshold}${RESET}`);
  if (options.configPath) console.log(`  ${DIM}Config: ${options.configPath}${RESET}`);
  console.log();

  const results: IosSnapshotResult[] = [];
  for (const [index, source] of options.sources.entries()) {
    const label = options.labels[index]!;
    const bundleId = bundleIdOf(source);
    console.log(`  ${BOLD}${label}${RESET} ${DIM}(${source})${RESET}`);
    const currentPath = join(outputDir, `${label}-current.png`);
    const captured = await captureIos({ bundleId, device: options.device, framePath: currentPath, log: (line) => console.log(`    ${DIM}${line}${RESET}`) });
    const vp = `${slug(captured.device.name)}-${slug(captured.device.runtime)}`;
    // The device is part of the file name so a second device never overwrites the first's baseline.
    const namedCurrent = join(outputDir, `${label}-${vp}-current.png`);
    await copyFile(currentPath, namedCurrent);
    const baselinePath = join(outputDir, `${label}-${vp}-baseline.png`);
    let hasBaseline = false;
    try {
      await access(baselinePath);
      hasBaseline = true;
    } catch { /* first run */ }
    if (!hasBaseline) {
      await copyFile(namedCurrent, baselinePath);
      console.log(`    ${vp.padEnd(24)} ${DIM}(new baseline)${RESET}`);
      results.push({ url: source, label, viewport: vp, screenshotPath: namedCurrent, isNew: true });
      continue;
    }
    const snap: VrtSnapshot = {
      testId: `${label}-${vp}`,
      testTitle: `${label} ${vp}`,
      projectName: "snapshot",
      screenshotPath: namedCurrent,
      baselinePath,
      status: "changed",
    };
    const diff = await compareScreenshots(snap, { outputDir, threshold: options.threshold });
    const diffRatio = diff?.diffRatio ?? 0;
    const report = diffRatio > 0 ? await generateDiffReport(snap, { outputDir, detectShift: true, threshold: options.threshold }) : null;
    const globalShift = report?.globalShift ?? 0;
    const compensatedDiffRatio = report ? report.compensatedDiffCount / report.totalPixels : diffRatio;
    const shiftOnly = report?.shiftOnly ?? false;
    const pct = (diffRatio * 100).toFixed(2);
    const colour = diffRatio === 0 ? GREEN : diffRatio < 0.01 ? YELLOW : RED;
    console.log(`    ${vp.padEnd(24)} ${colour}${pct}%${RESET}${globalShift ? ` ${DIM}(shift ${globalShift > 0 ? "+" : ""}${globalShift}px)${RESET}` : ""}`);
    results.push({ url: source, label, viewport: vp, screenshotPath: namedCurrent, baselinePath, diffRatio, isNew: false, globalShift, compensatedDiffRatio, shiftOnly });
  }

  console.log();
  hr();
  console.log();
  const compared = results.filter((r) => !r.isNew);
  const newBaselines = results.filter((r) => r.isNew);
  const changed = compared.filter((r) => (r.diffRatio ?? 0) > 0);
  if (newBaselines.length > 0) console.log(`  ${DIM}New baselines: ${newBaselines.length}${RESET}`);
  if (compared.length > 0) {
    console.log(`  Compared: ${compared.length} | Diff > 0: ${changed.length}`);
    if (changed.length > 0) {
      for (const c of changed) console.log(`    ${RED}${c.label} ${c.viewport}: ${((c.diffRatio ?? 0) * 100).toFixed(2)}%${RESET}`);
    } else {
      console.log(`  ${GREEN}All snapshots match baseline${RESET}`);
    }
  }
  const exitStatus = determineSnapshotExitCode(results, {
    failOnDiff: options.failOnDiff,
    failOnNewBaseline: options.failOnNewBaseline,
    maxDiffRatio: options.maxDiffRatio,
  });
  const worstDiff = compared.reduce((max, r) => Math.max(max, r.diffRatio ?? 0), 0);
  appendRunLedger({
    tool: "snapshot",
    source: options.sources.join(" "),
    headline: {
      verdict: exitStatus.exitCode === 0 ? "clean" : "defects",
      captured: results.length,
      newBaselines: newBaselines.length,
      compared: compared.length,
      changed: changed.length,
      worstDiffRatio: Number(worstDiff.toFixed(6)),
    },
  });
  await writeFile(
    join(outputDir, "snapshot-report.json"),
    JSON.stringify({
      timestamp: new Date().toISOString(),
      urls: options.sources,
      labels: options.labels,
      options: {
        threshold: options.threshold,
        failOnDiff: options.failOnDiff,
        failOnNewBaseline: options.failOnNewBaseline,
        maxDiffRatio: options.maxDiffRatio ?? null,
        configPath: options.configPath ?? null,
        platform: "ios-simulator",
      },
      results,
      exitStatus,
    }, null, 2),
  );
  console.log();
  if (exitStatus.exitCode !== 0) {
    for (const reason of exitStatus.reasons) console.log(`  ${RED}${reason}${RESET}`);
    console.log();
  }
  return exitStatus.exitCode;
}

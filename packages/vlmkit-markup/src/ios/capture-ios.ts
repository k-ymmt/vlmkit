/**
 * One iOS capture: enable accessibility on the device, build the agent, relaunch the app
 * with it injected, wait for the screen to settle, tap through `--tap` names, then take the
 * dump and the screenshot together.
 *
 * Settling is the Flutter collector's rule again: the dump is ready when it stops changing.
 * Two dumps 150ms apart that serialize identically end the wait; a route push animates for
 * ~350ms, so a tap is followed by the same wait. No fixed sleep anywhere.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { UsageError } from "@mizchi/vlmkit-core/cli-error.ts";
import { agentRequest, ensureAgent, waitForAgent, type AgentBuild } from "./agent.ts";
import { findTapTarget, parseIosDump, tappableNames, type IosDump } from "./dump.ts";
import { assertInstalled, ensureAccessibility, isAliveProcess, launchWithAgent, resolveDevice, screenshot, type SimDevice } from "./simctl.ts";

export const IOS_SOURCE_PREFIX = "ios:";
export const isIosSource = (source: string): boolean => source.startsWith(IOS_SOURCE_PREFIX);
export const bundleIdOf = (source: string): string => source.slice(IOS_SOURCE_PREFIX.length);

export interface CaptureIosOptions {
  bundleId: string;
  /** `booted`, a UDID or a name. */
  device?: string;
  /** Tap these by exact accessible name, in order, before the final dump. */
  taps?: string[];
  /** Where to write the screenshot (at the screen scale). */
  framePath: string;
  /** Also write the raw dump here — the fixture for a test that needs no simulator. */
  dumpPath?: string;
  timeoutMs?: number;
  /** Called with progress lines. */
  log?: (line: string) => void;
}

export interface CaptureIosResult {
  dump: IosDump;
  device: SimDevice;
  pid: number;
  agent: AgentBuild;
  accessibility: "already" | "enabled";
  taps: Array<{ name: string; path: string; x: number; y: number; hit: string }>;
  /** Milliseconds until the first dump matched the next. */
  settledMs: number;
}

const signature = (dump: IosDump): string => JSON.stringify(dump.windows);

async function dump(socketPath: string): Promise<IosDump> {
  const r = await agentRequest(socketPath, { cmd: "dump" }, 60000);
  if (!r.ok) throw new UsageError(`agent dump failed: ${r.error}`);
  return parseIosDump(r);
}

async function settle(socketPath: string, timeoutMs: number): Promise<{ dump: IosDump; ms: number }> {
  const start = Date.now();
  let last = await dump(socketPath);
  let lastSig = signature(last);
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 150));
    const next = await dump(socketPath);
    const sig = signature(next);
    if (sig === lastSig) return { dump: next, ms: Date.now() - start };
    last = next;
    lastSig = sig;
  }
  return { dump: last, ms: Date.now() - start };
}

export async function captureIos(options: CaptureIosOptions): Promise<CaptureIosResult> {
  const log = options.log ?? (() => {});
  const timeoutMs = options.timeoutMs ?? 30000;
  const device = await resolveDevice(options.device);
  await assertInstalled(device.udid, options.bundleId);
  const accessibility = await ensureAccessibility(device.udid);
  if (accessibility === "enabled") log(`enabled ApplicationAccessibilityEnabled on ${device.name} (UIKit answers accessibility only when the device says a client exists)`);
  const agent = await ensureAgent();
  log(`agent ${agent.from}: ${agent.dylib}`);
  // A short path: sun_path holds 104 bytes, and the simulator shares the host's /tmp.
  const sockDir = await mkdtemp(join("/tmp", "vlmkit-ios-"));
  const socketPath = join(sockDir, "agent.sock");
  try {
    const pid = await launchWithAgent(device.udid, options.bundleId, agent.dylib, socketPath);
    log(`launched ${options.bundleId} (pid ${pid}) on ${device.name}, ${device.runtime}`);
    await waitForAgent(socketPath, { timeoutMs, alive: () => isAliveProcess(pid) });
    let settled = await settle(socketPath, Math.min(timeoutMs, 10000));
    const settledMs = settled.ms;
    const taps: CaptureIosResult["taps"] = [];
    for (const name of options.taps ?? []) {
      const target = findTapTarget(settled.dump, name);
      if (!target) {
        const names = tappableNames(settled.dump);
        throw new UsageError(
          `--tap ${JSON.stringify(name)}: no tappable node has that exact name on this screen.`
          + ` Tappable names here: ${names.length ? names.map((n) => JSON.stringify(n)).join(", ") : "(none)"}.`,
        );
      }
      const r = await agentRequest(socketPath, { cmd: "tap", x: target.x, y: target.y }, 10000);
      if (!r.ok) throw new UsageError(`--tap ${JSON.stringify(name)} failed: ${r.error}`);
      const hit = r.hit as { cls: string; label: string | null } | undefined;
      taps.push({ name, path: target.path, x: target.x, y: target.y, hit: hit ? `${hit.cls}${hit.label ? ` "${hit.label}"` : ""}` : "?" });
      log(`tapped "${name}" at ${target.x.toFixed(1)},${target.y.toFixed(1)} → ${taps[taps.length - 1]!.hit}`);
      await new Promise((r) => setTimeout(r, 200));
      settled = await settle(socketPath, Math.min(timeoutMs, 10000));
    }
    await mkdir(dirname(options.framePath), { recursive: true });
    await screenshot(device.udid, options.framePath);
    const final = await dump(socketPath);
    if (options.dumpPath) {
      await mkdir(dirname(options.dumpPath), { recursive: true });
      await writeFile(options.dumpPath, JSON.stringify(final, null, 1) + "\n");
    }
    return { dump: final, device, pid, agent, accessibility, taps, settledMs };
  } finally {
    await rm(sockDir, { recursive: true, force: true });
  }
}

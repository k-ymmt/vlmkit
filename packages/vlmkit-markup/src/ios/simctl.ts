/**
 * `xcrun simctl`, the four calls the iOS collector needs: which device, launch the app with
 * the agent in its environment, screenshot, and the one device setting that makes UIKit
 * answer accessibility questions at all.
 *
 * **Accessibility is off in a process nobody is inspecting.** UIKit loads its accessibility
 * bundle only when the device says an assistive client exists; without it every `UILabel`
 * reports `isAccessibilityElement == NO` and no label — the first dump on the fixture had
 * one element (the custom control that set its own label) out of twenty-two. The switch is
 * the device default `com.apple.Accessibility ApplicationAccessibilityEnabled`; measured
 * 2026-09-27 on iOS 27.0, that one key is enough (`AccessibilityEnabled` and
 * `AutomationEnabled` are not needed). It is read at app launch, persists on the device, and
 * `ensureAccessibility` sets it once and says so.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { UsageError } from "@mizchi/vlmkit-core/cli-error.ts";

const run = promisify(execFile);

export interface SimDevice {
  udid: string;
  name: string;
  state: string;
  runtime: string;
  isAvailable: boolean;
}

async function simctl(args: string[], env?: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  try {
    return await run("xcrun", ["simctl", ...args], { env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    const e = error as { stderr?: string; stdout?: string; message: string; code?: string };
    if (e.code === "ENOENT") throw new UsageError("xcrun not found: the iOS collector needs Xcode's command line tools (xcode-select --install).");
    throw new UsageError(`xcrun simctl ${args.slice(0, 2).join(" ")} failed: ${(e.stderr || e.stdout || e.message).trim()}`);
  }
}

export async function listDevices(): Promise<SimDevice[]> {
  const { stdout } = await simctl(["list", "-j", "devices"]);
  const parsed = JSON.parse(stdout) as { devices: Record<string, Array<Omit<SimDevice, "runtime">>> };
  const out: SimDevice[] = [];
  for (const [runtime, devices] of Object.entries(parsed.devices)) {
    for (const d of devices) out.push({ ...d, runtime: runtime.replace(/^com\.apple\.CoreSimulator\.SimRuntime\./, "") });
  }
  return out;
}

/**
 * `booted` (the default), a UDID, or a device name. A named device that is not booted is
 * refused with the boot command rather than booted here: a boot takes a minute and changes
 * the machine's state, which a scan should not do on its own.
 */
export async function resolveDevice(device = "booted"): Promise<SimDevice> {
  const devices = await listDevices();
  const booted = devices.filter((d) => d.state === "Booted");
  if (device === "booted") {
    if (booted.length === 0) {
      const available = devices.filter((d) => d.isAvailable).slice(0, 6).map((d) => `${d.name} (${d.runtime}): ${d.udid}`);
      throw new UsageError(
        "no booted simulator. Boot one first: xcrun simctl boot <udid>  (then open it with Simulator.app / DeviceHub.app)"
        + (available.length ? `\n  available: ${available.join("; ")}` : ""),
      );
    }
    return booted[0]!;
  }
  const byUdid = devices.find((d) => d.udid.toLowerCase() === device.toLowerCase());
  const byName = byUdid ? undefined : devices.filter((d) => d.name === device && d.isAvailable);
  const match = byUdid ?? byName?.find((d) => d.state === "Booted") ?? byName?.[0];
  if (!match) throw new UsageError(`no simulator named or identified by ${JSON.stringify(device)} (xcrun simctl list devices).`);
  if (match.state !== "Booted") throw new UsageError(`${match.name} (${match.udid}) is ${match.state}; boot it first: xcrun simctl boot ${match.udid}`);
  return match;
}

/** The app's container path, which fails when it is not installed. */
export async function assertInstalled(udid: string, bundleId: string): Promise<void> {
  try {
    await simctl(["get_app_container", udid, bundleId]);
  } catch {
    throw new UsageError(
      `${bundleId} is not installed on the booted simulator. Install it first: xcrun simctl install ${udid} path/to/App.app`
      + " (the fixture: examples/ios-sample/build.sh)",
    );
  }
}

/** Launch with the agent injected; returns the host pid (simulator processes are host processes). */
export async function launchWithAgent(udid: string, bundleId: string, agentDylib: string, socketPath: string): Promise<number> {
  const { stdout } = await simctl(["launch", "--terminate-running-process", udid, bundleId], {
    SIMCTL_CHILD_DYLD_INSERT_LIBRARIES: agentDylib,
    SIMCTL_CHILD_VLMKIT_IOS_SOCKET: socketPath,
  });
  const m = /:\s*(\d+)\s*$/.exec(stdout.trim());
  if (!m) throw new UsageError(`simctl launch gave no pid: ${stdout.trim()}`);
  return Number(m[1]);
}

export async function terminateApp(udid: string, bundleId: string): Promise<void> {
  try {
    await simctl(["terminate", udid, bundleId]);
  } catch {
    // not running
  }
}

export async function screenshot(udid: string, path: string): Promise<void> {
  await simctl(["io", udid, "screenshot", path]);
}

/** Returns "already" when the key was set, "enabled" when this call set it. */
export async function ensureAccessibility(udid: string): Promise<"already" | "enabled"> {
  try {
    const { stdout } = await simctl(["spawn", udid, "defaults", "read", "com.apple.Accessibility", "ApplicationAccessibilityEnabled"]);
    if (stdout.trim() === "1") return "already";
  } catch {
    // key absent
  }
  await simctl(["spawn", udid, "defaults", "write", "com.apple.Accessibility", "ApplicationAccessibilityEnabled", "-bool", "true"]);
  return "enabled";
}

export const isAliveProcess = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

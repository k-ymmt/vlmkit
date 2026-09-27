/**
 * The agent dylib: built from `ios-agent/VlmkitAgent.m` on first use with the simulator SDK's
 * clang and cached by content, then spoken to over its unix socket.
 *
 * Built here rather than shipped: a dylib for the simulator has to match the host's
 * architecture and is worth nothing without Xcode on the machine, and Xcode is exactly what
 * makes building it a one-second `clang` call. The source ships in the package; the cache
 * key is the source, the SDK path (so an Xcode upgrade rebuilds) and the architectures.
 * `VLMKIT_IOS_AGENT=/path/to.dylib` uses a prebuilt one instead.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile } from "node:fs/promises";
import { homedir, tmpdir, arch as hostArch } from "node:os";
import { dirname, join } from "node:path";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { UsageError } from "@mizchi/vlmkit-core/cli-error.ts";

const run = promisify(execFile);

export const AGENT_SOURCE = fileURLToPath(new URL("../../ios-agent/VlmkitAgent.m", import.meta.url));

const exists = (p: string) => access(p).then(() => true, () => false);

function cacheRoot(): string {
  const home = process.env.HOME || homedir();
  return process.platform === "darwin" && home ? join(home, "Library", "Caches", "vlmkit", "ios-agent") : join(tmpdir(), "vlmkit-ios-agent");
}

export interface AgentBuild {
  dylib: string;
  /** `cached`, `built`, or `env` for VLMKIT_IOS_AGENT. */
  from: "cached" | "built" | "env";
  arches: string[];
}

/** The built dylib's path, building and caching it when needed. */
export async function ensureAgent(): Promise<AgentBuild> {
  const preset = process.env.VLMKIT_IOS_AGENT;
  if (preset) {
    if (!(await exists(preset))) throw new UsageError(`VLMKIT_IOS_AGENT=${preset} does not exist.`);
    return { dylib: preset, from: "env", arches: [] };
  }
  const source = await readFile(AGENT_SOURCE, "utf8").catch(() => {
    throw new UsageError(`agent source missing at ${AGENT_SOURCE}; the package is incomplete.`);
  });
  let sdk: string;
  try {
    sdk = (await run("xcrun", ["--sdk", "iphonesimulator", "--show-sdk-path"])).stdout.trim();
  } catch (error) {
    throw new UsageError(`no iOS simulator SDK (xcrun --sdk iphonesimulator --show-sdk-path): ${(error as Error).message.trim()}. Install Xcode and its iOS platform.`);
  }
  const arches = hostArch() === "arm64" ? ["arm64", "x86_64"] : ["x86_64"];
  const key = createHash("sha256").update(source).update(sdk).update(arches.join(",")).digest("hex").slice(0, 16);
  const dylib = join(cacheRoot(), key, "libvlmkit-ios-agent.dylib");
  if (await exists(dylib)) return { dylib, from: "cached", arches };
  await mkdir(dirname(dylib), { recursive: true });
  const build = async (list: string[]) => run("xcrun", [
    "--sdk", "iphonesimulator", "clang",
    ...list.flatMap((a) => ["-arch", a]),
    "-isysroot", sdk, "-mios-simulator-version-min=17.0",
    "-dynamiclib", "-fobjc-arc", "-O1", "-Wall", "-Wno-unused-function",
    "-framework", "Foundation", "-framework", "UIKit", "-framework", "CoreGraphics", "-framework", "QuartzCore",
    AGENT_SOURCE, "-o", dylib,
  ], { maxBuffer: 16 * 1024 * 1024 });
  try {
    await build(arches);
  } catch (first) {
    // A universal build can fail on a toolchain missing one slice; the host's own is enough.
    const host = [hostArch() === "arm64" ? "arm64" : "x86_64"];
    try {
      await build(host);
      return { dylib, from: "built", arches: host };
    } catch {
      const e = first as { stderr?: string; message: string };
      throw new UsageError(`building the iOS agent failed:\n${(e.stderr || e.message).trim()}`);
    }
  }
  return { dylib, from: "built", arches };
}

// ---------------------------------------------------------------------------
// Socket client: one JSON line per connection, as the agent serves it.

export type AgentResponse = { ok: true; [k: string]: unknown } | { ok: false; error: string };

export function agentRequest(socketPath: string, request: Record<string, unknown>, timeoutMs = 30000): Promise<AgentResponse> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = createConnection({ path: socketPath });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`agent did not answer ${JSON.stringify(request.cmd)} within ${timeoutMs}ms`));
    }, timeoutMs);
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (c: Buffer | string) => chunks.push(Buffer.from(c)));
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on("close", () => {
      clearTimeout(timer);
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) return reject(new Error("agent closed the connection with no answer"));
      try {
        resolve(JSON.parse(text) as AgentResponse);
      } catch (error) {
        reject(new Error(`agent answered non-JSON: ${(error as Error).message}`));
      }
    });
  });
}

/** Retry the connection until the agent's server is up or the app is gone. */
export async function waitForAgent(
  socketPath: string,
  options: { timeoutMs: number; alive: () => boolean },
): Promise<{ ok: true; [k: string]: unknown }> {
  const deadline = Date.now() + options.timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const r = await agentRequest(socketPath, { cmd: "ping" }, 5000);
      if (r.ok) return r;
      last = r.error;
    } catch (error) {
      last = (error as Error).message;
    }
    if (!options.alive()) {
      throw new UsageError(
        "the app exited before the agent answered — a crash at launch? Look in ~/Library/Logs/DiagnosticReports/,"
        + " or run it with the same env by hand (SIMCTL_CHILD_DYLD_INSERT_LIBRARIES). Last error: " + last,
      );
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new UsageError(`the agent in the app did not answer within ${options.timeoutMs}ms (${last}).`);
}

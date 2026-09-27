/**
 * `vlmkit scan scene`: a scene (`--elements` JSON) and its 1x frame from a platform with no
 * DOM — today the iOS Simulator (`ios:<bundle-id>`), or a saved iOS dump. The style gates
 * and `check integrity` / `check copy` then judge it with no simulator and no browser.
 */
import { readFile, mkdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, extname, relative, resolve } from "node:path";
import { decodePng, encodePng } from "@mizchi/vlmkit-core/png-utils.ts";
import { UsageError } from "@mizchi/vlmkit-core/cli-error.ts";
import type { SceneElement } from "@mizchi/vlmkit-judge/scene.ts";
import { bundleIdOf, captureIos, isIosSource } from "./capture-ios.ts";
import { iosDumpToScene, parseIosDump, type IosDump } from "./dump.ts";
import { downscaleFrame } from "./frame.ts";

export const DEFAULT_SCENE = ".vlmkit/scene.json";

export interface ScanSceneOptions {
  /** `ios:<bundle-id>`, or a saved dump (`.json`). */
  source: string;
  out: string;
  /** iOS: where to write the 1x frame. Dump: the screenshot taken with it (at the screen scale). */
  frame?: string;
  device?: string;
  taps?: string[];
  /** Also keep the raw dump. */
  dump?: string;
  timeout?: number;
}

export interface ScanSceneReport {
  source: string;
  platform: string;
  out: string;
  frame: string | null;
  viewport: { width: number; height: number };
  scale: number;
  taps: string[];
  device: string | null;
  counts: { elements: number; text: number; fields: number; buttons: number };
  notes: string[];
}

export const isDumpFile = (source: string): boolean => extname(source).toLowerCase() === ".json";

async function readDumpFile(source: string): Promise<IosDump> {
  let text: string;
  try {
    text = await readFile(source, "utf8");
  } catch (error) {
    throw new UsageError(`cannot read ${source}: ${(error as Error).message}`);
  }
  return parseIosDump(text);
}

/** Write the frame the scene's gates read: the screenshot boxed down from the screen scale to 1x. */
export async function writeSceneFrame(screenshotPath: string, scale: number, out: string): Promise<void> {
  const png = await decodePng(screenshotPath);
  await mkdir(dirname(out), { recursive: true });
  await encodePng(out, downscaleFrame(png, scale));
}

export async function runScanScene(options: ScanSceneOptions): Promise<ScanSceneReport> {
  const out = resolve(options.out);
  const stem = out.slice(0, out.length - extname(out).length);
  const notes: string[] = [];
  let dump: IosDump;
  let frame: string | null = null;
  let device: string | null = null;
  if (isIosSource(options.source)) {
    const framePath = resolve(options.frame ?? `${stem}.png`);
    const frameStem = framePath.slice(0, framePath.length - extname(framePath).length);
    let raw = `${frameStem}.raw.png`;
    const captured = await captureIos({
      bundleId: bundleIdOf(options.source),
      device: options.device,
      taps: options.taps,
      framePath: raw,
      dumpPath: options.dump ? resolve(options.dump) : undefined,
      timeoutMs: options.timeout,
      log: (line) => notes.push(line),
    });
    dump = captured.dump;
    device = `${captured.device.name} (${captured.device.runtime})`;
    const scaled = `${frameStem}@${dump.screen.scale}x.png`;
    await rename(raw, scaled);
    raw = scaled;
    await writeSceneFrame(raw, dump.screen.scale, framePath);
    frame = framePath;
    notes.push(`frame ${basename(raw)} kept at ${dump.screen.scale}x beside the 1x ${basename(framePath)}`);
  } else if (isDumpFile(options.source)) {
    dump = await readDumpFile(options.source);
    if (options.frame) {
      const framePath = resolve(options.frame);
      const png = await decodePng(framePath);
      const at1x = Math.abs(png.width - dump.screen.width) < 2;
      if (at1x) {
        frame = framePath;
      } else {
        frame = `${stem}.png`;
        await writeSceneFrame(framePath, dump.screen.scale, frame);
        notes.push(`--frame is ${png.width}x${png.height} (${dump.screen.scale}x); wrote it at 1x as ${relative(dirname(out), frame) || basename(frame)}`);
      }
    }
  } else {
    throw new UsageError(`scan scene takes ios:<bundle-id> or a saved iOS dump (.json), got ${JSON.stringify(options.source)}. For a page, the gates read the DOM directly.`);
  }
  const elements: SceneElement[] = iosDumpToScene(dump);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify({
    format: "vlmkit-scene/1",
    platform: dump.platform,
    viewport: { width: dump.screen.width, height: dump.screen.height },
    ...(frame ? { frame: relative(dirname(out), frame) || basename(frame) } : {}),
    elements,
  }, null, 1) + "\n");
  return {
    source: options.source,
    platform: dump.platform,
    out: options.out,
    frame,
    viewport: { width: dump.screen.width, height: dump.screen.height },
    scale: dump.screen.scale,
    taps: options.taps ?? [],
    device,
    counts: {
      elements: elements.length,
      text: elements.filter((e) => (e.text ?? "").trim()).length,
      fields: elements.filter((e) => e.role === "field").length,
      buttons: elements.filter((e) => e.role === "button").length,
    },
    notes,
  };
}

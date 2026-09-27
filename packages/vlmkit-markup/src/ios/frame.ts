/**
 * The simulator's screenshot is at the screen scale (3x on an iPhone 17). The a11y tree
 * carries that as `scale`; the scene contract has no such field — its gates read the image
 * at 1:1 with the element rects — so the scene's frame is the screenshot boxed down to 1x.
 */
import type { PngData } from "@mizchi/vlmkit-core/png-utils.ts";

/** Box-filter downscale by an integer factor; nearest sampling when the factor is not one. */
export function downscaleFrame(png: PngData, scale: number): PngData {
  if (scale <= 1) return png;
  const f = Math.round(scale);
  const integer = Math.abs(f - scale) < 1e-6 && f > 1;
  const width = Math.floor(png.width / scale);
  const height = Math.floor(png.height / scale);
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (!integer) {
        const sx = Math.min(png.width - 1, Math.floor((x + 0.5) * scale));
        const sy = Math.min(png.height - 1, Math.floor((y + 0.5) * scale));
        const i = (sy * png.width + sx) * 4;
        data[o] = png.data[i]!; data[o + 1] = png.data[i + 1]!; data[o + 2] = png.data[i + 2]!; data[o + 3] = png.data[i + 3]!;
        continue;
      }
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < f; dy++) {
        for (let dx = 0; dx < f; dx++) {
          const i = ((y * f + dy) * png.width + (x * f + dx)) * 4;
          r += png.data[i]!; g += png.data[i + 1]!; b += png.data[i + 2]!; a += png.data[i + 3]!;
        }
      }
      const n = f * f;
      data[o] = Math.round(r / n); data[o + 1] = Math.round(g / n); data[o + 2] = Math.round(b / n); data[o + 3] = Math.round(a / n);
    }
  }
  return { width, height, data };
}

import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import pngjs from "pngjs";

const root = resolve(import.meta.dirname, "..");
const plugin = resolve(root, "com.agentdeck.monitor.sdPlugin");
await mkdir(resolve(plugin, "bin"), { recursive: true });
await build({
  entryPoints: [resolve(root, "src", "index.ts")],
  outfile: resolve(plugin, "bin", "index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: true,
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
});
await build({
  entryPoints: [resolve(root, "src", "property-inspector.ts")],
  outfile: resolve(plugin, "bin", "property-inspector.js"),
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2023",
  sourcemap: true,
});

const { PNG } = pngjs;
const writePluginIcon = async (size, suffix) => {
  const png = new PNG({ width: size, height: size });
  const center = size / 2;
  const outer = size * 0.31;
  const inner = size * 0.18;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const offset = (y * size + x) * 4;
      const inOuterSquare =
        Math.abs(x - center) <= outer && Math.abs(y - center) <= outer;
      const inInnerSquare =
        Math.abs(x - center) <= inner && Math.abs(y - center) <= inner;
      const accent = inOuterSquare && !inInnerSquare;
      png.data[offset] = accent ? 56 : 15;
      png.data[offset + 1] = accent ? 189 : 23;
      png.data[offset + 2] = accent ? 248 : 42;
      png.data[offset + 3] = 255;
    }
  }
  const output = resolve(plugin, "assets", `plugin${suffix}.png`);
  await new Promise((resolvePromise, reject) => {
    png
      .pack()
      .pipe(createWriteStream(output))
      .on("finish", resolvePromise)
      .on("error", reject);
  });
};

await writePluginIcon(128, "");
await writePluginIcon(256, "@2x");

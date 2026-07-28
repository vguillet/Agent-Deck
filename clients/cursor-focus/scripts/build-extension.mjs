import { resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
await build({
  entryPoints: [resolve(root, "src", "extension.ts")],
  outfile: resolve(root, "dist", "extension.cjs"),
  bundle: true,
  external: ["vscode"],
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: false,
});

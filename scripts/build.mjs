import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const dist = path.join(root, "dist");
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await build({
  entryPoints: {
    background: path.join(root, "src/background.js"),
    popup: path.join(root, "src/popup.js"),
    options: path.join(root, "src/options.js"),
  },
  outdir: dist,
  bundle: true,
  minify: false,
  sourcemap: false,
  format: "iife",
  platform: "browser",
  target: ["firefox128"],
  logLevel: "info",
});

await cp(path.join(root, "static"), dist, { recursive: true });
await cp(
  path.join(root, "THIRD_PARTY_NOTICES.md"),
  path.join(dist, "THIRD_PARTY_NOTICES.md"),
);

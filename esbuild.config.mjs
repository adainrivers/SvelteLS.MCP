import { build } from "esbuild";

// Bundle our MCP server (all deps inlined)
await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: "dist/bundle.cjs",
  external: ["node:sea"],
  sourcemap: false,
  minify: false,
  logOverride: {
    "direct-eval": "silent",
    "empty-import-meta": "silent",
  },
});

console.error("Built dist/bundle.cjs");

// Bundle svelteserver (all deps inlined)
await build({
  entryPoints: ["node_modules/svelte-language-server/bin/server.js"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: "dist/svelteserver-bundle.cjs",
  sourcemap: false,
  minify: false,
  logOverride: {
    "require-resolve-not-external": "silent",
  },
});

console.error("Built dist/svelteserver-bundle.cjs");

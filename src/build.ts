/**
 * build.ts — Simple build script for client-side code.
 * Bundles all client TS modules into static/js/app.js using esbuild.
 */
const result = await Bun.build({
  entrypoints: ["./src/client/main.ts"],
  outdir: "./static/js",
  naming: "bundle.[ext]",
  target: "browser",
  format: "esm",
  splitting: false,
  minify: false,
  sourcemap: "inline",
});

if (!result.success) {
  console.error("Build failed:");
  for (const msg of result.logs) {
    console.error(msg);
  }
  process.exit(1);
}

console.log("✓ Client bundle built → static/js/bundle.js (legacy js/app.js preserved for parity)");

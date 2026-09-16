import esbuild from "esbuild";
import process from "process";

const prod = process.argv[2] === "production";
const testMode = process.argv[2] === "test";

if (testMode) {
  await esbuild.build({
    entryPoints: ["src/core.ts"],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node18",
    outfile: "tests/build/core.cjs",
    logLevel: "warning",
  });
  console.log("bundled tests/build/core.cjs");
} else {
  const ctx = await esbuild.context({
    entryPoints: ["src/main.ts"],
    bundle: true,
    external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", "builtin-modules"],
    format: "cjs",
    target: "es2018",
    logLevel: "info",
    sourcemap: prod ? false : "inline",
    treeShaking: true,
    outfile: "main.js",
  });
  if (prod) {
    await ctx.rebuild();
    await ctx.dispose();
  } else {
    await ctx.watch();
  }
}

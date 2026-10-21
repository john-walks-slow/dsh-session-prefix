/**
 * 把浏览器半边（src/client）打成 Web 外壳的 lazy-CJS bundle：
 * `window.__ModuleLoader__.load({ id, factory })`。
 * 外部说明符（react、react-dom/*、@deepseek-ai/*）保持为 shared require，由外壳的模块表在运行时解析。
 */
import { build } from "esbuild";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";

const outBundle = "lib/client.bundle.js";
await rm(outBundle, { force: true });
await mkdir("lib", { recursive: true });
await build({
  entryPoints: ["src/client/index.ts"],
  bundle: true,
  format: "cjs",
  platform: "browser",
  outfile: outBundle,
  jsx: "automatic",
  target: "es2022",
  sourcemap: false,
  external: ["react", "react-dom/*", "react/jsx-runtime", "@deepseek-ai/*"],
  logLevel: "info"
});
const body = await readFile(outBundle, "utf8");
const wrapped = [
  "window.__ModuleLoader__.load({",
  '\tid: "dsh-session-prefix",',
  "\tfactory: (require) => {",
  "\t\tvar module = { exports: {} };",
  "\t\tvar exports = module.exports;",
  '\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
  body,
  "\t\treturn module.exports;",
  "\t}",
  "});"
].join("\n");
await writeFile("lib/client.js", wrapped, "utf8");
await rm(outBundle, { force: true });
console.log("lib/client.js written:", wrapped.length, "chars");

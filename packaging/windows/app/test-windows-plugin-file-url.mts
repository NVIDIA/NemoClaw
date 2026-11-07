// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import Module, { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalizeWindowsNativePluginRequire } from "./openclaw-app-resources.mts";

const index = process.argv.indexOf("--source-root");
if (index < 0 || !process.argv[index + 1])
  throw new Error("The pinned materialized source root is required.");
const source = path.resolve(process.argv[index + 1]);
const relative = "dist/plugin-module-loader-cache-uqaaAPup.js";
const original = fs.readFileSync(path.join(source, relative), "utf8");
const patched = normalizeWindowsNativePluginRequire(relative, original);
const syntax = createRequire(import.meta.url)(
  path.join(source, "node_modules/typescript"),
) as typeof import("typescript");
const names = new Set([
  "isJavaScriptModulePath",
  "isMissingTargetModuleError",
  "isSourceTransformFallbackError",
  "tryNativeRequireJavaScriptModule",
  "requireWithOptionalAliases",
  "withNativeRequireAliases",
]);
type Result = { ok: boolean; moduleExport?: { identity?: string } };
function actualLoader(text: string, platform: string) {
  const parsed = syntax.createSourceFile(
    "loader.js",
    text,
    syntax.ScriptTarget.Latest,
    true,
    syntax.ScriptKind.JS,
  );
  const functions = parsed.statements.filter(
    (statement) =>
      syntax.isFunctionDeclaration(statement) && statement.name && names.has(statement.name.text),
  );
  assert.equal(
    functions.length,
    names.size,
    "The exact native loader functions must be extracted.",
  );
  return new Function(
    "process",
    "path",
    "nodeRequire",
    "fileURLToPath",
    "pathToFileURL",
    "moduleWithResolver$1",
    functions.map((item) => item.getText(parsed)).join("\n") +
      "\nreturn tryNativeRequireJavaScriptModule;",
  )({ platform }, path, createRequire(import.meta.url), fileURLToPath, pathToFileURL, Module) as (
    file: string,
    options: Record<string, unknown>,
  ) => Result;
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), "native plugin URL ü "));
const options = {
  allowWindows: true,
  fallbackOnMissingDependency: true,
  fallbackOnNativeError: true,
};
const results: string[] = [];
try {
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
  const entry = path.join(root, "entry space ü.js");
  fs.writeFileSync(entry, 'export const identity="native-entry";\n');
  const url = pathToFileURL(entry).href;
  const before = actualLoader(original, "win32"),
    after = actualLoader(patched, "win32");
  assert.equal(before(url, options).ok, false, "The observed file-URL native miss must reproduce.");
  results.push("original-file-url-native-miss");
  assert.equal(after(url, options).moduleExport?.identity, "native-entry");
  results.push("windows-file-url-native-esm-hit");
  assert.equal(after(entry, options).moduleExport?.identity, "native-entry");
  results.push("plain-path-native-hit-preserved");
  assert.equal(actualLoader(patched, "darwin")(url, options).ok, false);
  results.push("other-platform-behavior-unchanged");
  for (const target of [
    pathToFileURL(path.join(root, "missing.js")).href,
    "https://invalid.example/entry.js",
    "file:///invalid%2Fencoded.js",
  ])
    assert.equal(after(target, options).ok, false);
  results.push("missing-nonfile-malformed-targets-not-admitted");
  const alias = path.join(root, "alias.js");
  fs.writeFileSync(alias, 'export {identity} from "reviewed-alias";\n');
  const resolver = (Module as unknown as { _resolveFilename: unknown })._resolveFilename;
  assert.equal(
    after(pathToFileURL(alias).href, { ...options, aliasMap: { "reviewed-alias": entry } })
      .moduleExport?.identity,
    "native-entry",
  );
  assert.equal((Module as unknown as { _resolveFilename: unknown })._resolveFilename, resolver);
  results.push("existing-native-aliases-and-restoration-preserved");
  assert.equal(normalizeWindowsNativePluginRequire("unrelated.js", original), original);
  assert.throws(
    () => normalizeWindowsNativePluginRequire(relative, original + "\n"),
    /reviewed native plugin loader changed/,
  );
  results.push("unrelated-source-unchanged-and-pin-drift-rejected");
  console.log(
    JSON.stringify({
      passed: true,
      controls: results,
      nativePlatform: process.platform,
      branchExercised: "win32",
      realNodeRequire: true,
      windowsExecutionObserved: process.platform === "win32",
    }),
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

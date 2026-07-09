// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Node's --require preload cannot execute TypeScript directly. Reuse this
// existing CommonJS test boundary as the minimal bootstrap for the typed
// source loader; the codebase growth guard prevents adding another JS file.
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const ts = require("typescript");

const sourceLoader = path.join(__dirname, "register-source-require.ts");
const bootstrapTypeScriptFiles = new Set([
  path.resolve(sourceLoader),
  path.resolve(__dirname, "source-require-cache.ts"),
]);
const previousTypeScriptLoader = Module._extensions[".ts"];

Module._extensions[".ts"] = (targetModule, filename) => {
  if (!bootstrapTypeScriptFiles.has(path.resolve(filename))) {
    if (previousTypeScriptLoader) {
      previousTypeScriptLoader(targetModule, filename);
      return;
    }
    throw new Error(`Refusing to bootstrap unexpected TypeScript module: ${filename}`);
  }

  // Loading source-require-cache.ts is what lets the real hook read tsconfig.src.json,
  // so this first hop intentionally uses minimal emit options instead of that config.
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: {
      esModuleInterop: true,
      inlineSourceMap: true,
      inlineSources: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filename,
  });
  targetModule._compile(outputText, filename);
};
require(sourceLoader);

function normalizeCommand(command) {
  return (Array.isArray(command) ? command.join(" ") : String(command)).replace(/'/g, "");
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function mockSandboxExecCurl(command, options = {}) {
  const normalized = normalizeCommand(command);
  if (!normalized.includes("sandbox exec") || !normalized.includes("curl")) {
    return null;
  }

  if (normalized.includes("/health") || normalized.includes("%{http_code}")) {
    return options.dashboardHealthCode || "200";
  }

  if (hasOwn(options, "defaultCurlOutput")) {
    return options.defaultCurlOutput;
  }

  return null;
}

function mockOnboardRunCapture(command, options = {}) {
  const normalized = normalizeCommand(command);
  if (/^docker run --rm --entrypoint \/usr\/bin\/ldd \S+ --version$/.test(normalized)) {
    return "ldd (GNU libc) 2.41";
  }
  return mockSandboxExecCurl(command, options);
}

module.exports = {
  mockOnboardRunCapture,
  mockSandboxExecCurl,
  normalizeCommand,
};

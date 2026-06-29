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
const { outputText } = ts.transpileModule(fs.readFileSync(sourceLoader, "utf8"), {
  compilerOptions: {
    esModuleInterop: true,
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: sourceLoader,
});
const sourceLoaderModule = new Module(sourceLoader, module);
sourceLoaderModule.filename = sourceLoader;
sourceLoaderModule.paths = module.paths;
sourceLoaderModule._compile(outputText, sourceLoader);

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

module.exports = {
  mockSandboxExecCurl,
  normalizeCommand,
};

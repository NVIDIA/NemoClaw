// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Node's --require preload cannot execute TypeScript directly. Reuse this
// existing CommonJS test boundary as the minimal bootstrap for the typed
// source loader; the codebase growth guard prevents adding another JS file.
const path = require("node:path");

function registerSourceRequire() {
  const fs = require("node:fs");
  const Module = require("node:module");
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
}

// Vitest setup files and NODE_OPTIONS preloads both depend on this hook.
registerSourceRequire();

function normalizeCommand(command) {
  return (Array.isArray(command) ? command.join(" ") : String(command)).replace(/'/g, "");
}

const OPENCLAW_SECURITY_INVENTORY_PROBE_PREFIX = Object.freeze([
  "run",
  "--rm",
  "--network",
  "none",
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges",
  "--read-only",
  "--entrypoint",
  "/bin/sh",
]);

const OPENCLAW_SECURITY_INVENTORY_PROBE = [
  "set -eu",
  "security_inventory=/usr/local/share/nemoclaw/security-packages.txt",
  'arch="$(dpkg --print-architecture)"',
  'test -f "$security_inventory"',
  'test ! -L "$security_inventory"',
  `test "$(stat -c '%u:%g:%a' "$security_inventory")" = "0:0:444"`,
  `printf '%s\\n' "architecture=$arch" "libexpat1=2.8.2-1" "libonig5=6.9.9-1+b1" "libjq1=1.8.2-1" "jq=1.8.2-1" "vim-common=2:9.2.0782-1" "vim-tiny=2:9.2.0782-1" "libssh2-1t64=1.11.1-1+deb13u1+nemoclaw1" "nemoclaw-python3.13-htmlparser-fix=3.13.5-2+deb13u4+nemoclaw1" | cmp -s - "$security_inventory"`,
  `printf '%s\\n' "nemoclaw-security-inventory-ok"`,
].join("; ");

function isOpenClawSecurityInventoryProbe(command) {
  const commandArgs = Array.isArray(command) ? command.map(String) : [];
  const dockerArgs = commandArgs[0] === "docker" ? commandArgs.slice(1) : commandArgs;
  const matches = (
    dockerArgs.length === 14 &&
    OPENCLAW_SECURITY_INVENTORY_PROBE_PREFIX.every(
      (expected, index) => dockerArgs[index] === expected,
    ) &&
    dockerArgs[11].length > 0 &&
    dockerArgs[12] === "-c" &&
    dockerArgs[13] === OPENCLAW_SECURITY_INVENTORY_PROBE
  );
  return matches;
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
  if (isOpenClawSecurityInventoryProbe(command)) {
    return "nemoclaw-security-inventory-ok";
  }
  if (/^docker run --rm --entrypoint \/usr\/bin\/ldd \S+ --version$/.test(normalized)) {
    return "ldd (GNU libc) 2.41";
  }
  return mockSandboxExecCurl(command, options);
}

module.exports = {
  isOpenClawSecurityInventoryProbe,
  mockOnboardRunCapture,
  mockSandboxExecCurl,
  normalizeCommand,
};

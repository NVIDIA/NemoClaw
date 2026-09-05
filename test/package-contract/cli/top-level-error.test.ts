// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "../../..");
const cliPath = JSON.stringify(path.join(REPO_ROOT, "bin", "nemoclaw.js"));
const nemohermesPath = JSON.stringify(path.join(REPO_ROOT, "bin", "nemohermes.js"));
const dispatchPath = JSON.stringify(
  path.join(REPO_ROOT, "dist", "lib", "cli", "public-dispatch.js"),
);
const loggerPath = JSON.stringify(path.join(REPO_ROOT, "dist", "lib", "cli", "logger.js"));
const mainPath = JSON.stringify(path.join(REPO_ROOT, "dist", "nemoclaw.js"));
const redactorPath = JSON.stringify(path.join(REPO_ROOT, "dist", "lib", "security", "redact.js"));

function expectTopLevelError(rejection: string, expectedStderr: string): void {
  const result = spawnSync(
    process.execPath,
    [
      "--eval",
      `const path = ${dispatchPath};
require.cache[path] = {
  loaded: true,
  exports: { dispatchCli: () => Promise.reject(${rejection}) },
};
require(${cliPath});`,
    ],
    {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      env: {
        ...process.env,
        NEMOCLAW_DISABLE_AUTO_DISPATCH: "0",
        NEMOCLAW_LOG_LEVEL: "info",
        NEMOCLAW_DEBUG: "0",
      },
    },
  );

  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe(expectedStderr);
  expect(result.stderr).not.toMatch(/\n\s+at |Node\.js v/);
}

function expectCleanLauncherFailure(env: NodeJS.ProcessEnv, expectedMessage: string): void {
  const result = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, "bin", "nemoclaw.js"), "--help"],
    {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      env: {
        ...process.env,
        ...env,
        NEMOCLAW_LOG_LEVEL: "info",
        NEMOCLAW_DEBUG: "0",
        NO_COLOR: "1",
      },
    },
  );

  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr.split(/\r?\n/).filter(Boolean)).toEqual([expectedMessage]);
}

function expectLoggerFallbackRedaction(secret: string, redactorUnavailable = false): void {
  const result = spawnSync(
    process.execPath,
    [
      "--eval",
      `const Module = require("node:module");
const cliPath = ${cliPath};
const loggerPath = ${loggerPath};
const mainPath = ${mainPath};
const redactorPath = ${redactorPath};
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  const resolved = Module._resolveFilename(request, parent, isMain);
  if (resolved === loggerPath) throw new Error("logger unavailable");
  if (${redactorUnavailable} && resolved === redactorPath) throw new Error("redactor unavailable");
  if (resolved === mainPath) throw new Error(${JSON.stringify(`startup failed ${secret}`)});
  return originalLoad.apply(this, arguments);
};
require(cliPath);`,
    ],
    {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      env: {
        ...process.env,
        NEMOCLAW_LOG_LEVEL: "info",
        NEMOCLAW_DEBUG: "0",
      },
    },
  );

  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe(
    redactorUnavailable ? "Error: Command failed.\n" : "Error: startup failed <REDACTED>\n",
  );
  expect(result.stderr).not.toContain(secret);
}

// An interrupted install or upgrade leaves the compiled entrypoint unresolvable.
// Reproduce that shape rather than deleting `dist/`, which the rest of this
// lane needs.
function runWithMissingCompiledCli(launcherPath = cliPath): SpawnSyncReturns<string> {
  return spawnSync(
    process.execPath,
    [
      "--eval",
      `const Module = require("node:module");
const cliPath = ${launcherPath};
const mainPath = ${mainPath};
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function(request, parent, isMain, options) {
  const resolved = originalResolveFilename.apply(this, arguments);
  if (resolved === mainPath) {
    const error = new Error("Cannot find module '" + mainPath + "'");
    error.code = "MODULE_NOT_FOUND";
    throw error;
  }
  return resolved;
};
require(cliPath);`,
    ],
    {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      env: {
        ...process.env,
        NEMOCLAW_LOG_LEVEL: "info",
        NEMOCLAW_DEBUG: "0",
      },
    },
  );
}

function runWithMissingCompiledDependency(): SpawnSyncReturns<string> {
  return spawnSync(
    process.execPath,
    [
      "--eval",
      `const Module = require("node:module");
const cliPath = ${cliPath};
const mainPath = ${mainPath};
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  const resolved = Module._resolveFilename(request, parent, isMain);
  if (resolved === mainPath) {
    const error = new Error("Cannot find module '/private/nemoclaw-secret-dependency'");
    error.code = "MODULE_NOT_FOUND";
    throw error;
  }
  return originalLoad.apply(this, arguments);
};
require(cliPath);`,
    ],
    {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      env: {
        ...process.env,
        NEMOCLAW_LOG_LEVEL: "info",
        NEMOCLAW_DEBUG: "0",
      },
    },
  );
}

describe("compiled CLI top-level errors", () => {
  it("prints an Error rejection as one line without a Node.js stack (#8202)", () => {
    expectTopLevelError('new Error("Command failed.")', "Error: Command failed.\n");
  });

  it("prints a non-Error rejection as one line without a Node.js stack (#8202)", () => {
    expectTopLevelError('"String failure."', "Error: String failure.\n");
  });

  it("prints a safe fallback when a rejected value cannot be converted to text (#8202)", () => {
    expectTopLevelError(
      '{ [Symbol.toPrimitive]() { throw new Error("coercion failed"); } }',
      "Error: Command failed.\n",
    );
  });

  it("replaces rejected error line breaks and redacts credentials (#8202)", () => {
    const secret = `nvapi-${"a".repeat(20)}`;
    const rejection = `new Error(${JSON.stringify(`First line\n${secret}\r\nLast line`)})`;
    expectTopLevelError(rejection, "Error: First line <REDACTED> Last line\n");
  });

  it("prints a module-load reserved-port error without a Node.js stack (#8202)", () => {
    expectCleanLauncherFailure(
      { NEMOCLAW_GATEWAY_PORT: "8081" },
      'Error: Invalid port: NEMOCLAW_GATEWAY_PORT="8081" — must not overlap the llama.cpp inference default port (8081)',
    );
  });

  it("does not echo an untrusted invalid port when the shared redactor cannot load (#8202)", () => {
    expectCleanLauncherFailure(
      { NEMOCLAW_GATEWAY_PORT: `openai-${"a".repeat(40)}` },
      "Error: Command failed.",
    );
  });

  it("redacts credential-shaped text when the logger fallback handles a module-load error (#8202)", () => {
    expectLoggerFallbackRedaction(`nvapi-${"a".repeat(20)}`);
  });

  it("prints a generic safe error when the logger and shared redactor cannot load (#8202)", () => {
    expectLoggerFallbackRedaction(`openai-${"a".repeat(40)}`, true);
  });

  it("reports an unfinished install when the compiled CLI cannot be found (#10372)", () => {
    const result = runWithMissingCompiledCli();

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.split(/\r?\n/).filter(Boolean)).toEqual([
      "Error: NemoClaw's compiled CLI is missing or incomplete, so no command can run.",
      "  An install or upgrade did not finish.",
      "  Rerun the installer command that you used to install NemoClaw to finish the installation.",
      "  The installer attempts to recover existing sandboxes. Follow any recovery guidance that it reports.",
    ]);
  });

  it("reports an unfinished install through the Hermes launcher (#10372)", () => {
    const result = runWithMissingCompiledCli(nemohermesPath);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("An install or upgrade did not finish.");
    expect(result.stderr).toContain("The installer attempts to recover existing sandboxes.");
    expect(result.stderr).not.toContain("dist");
    expect(result.stderr).not.toContain("Cannot find module");
  });

  it("does not report an unfinished install for a missing compiled dependency (#10372)", () => {
    const result = runWithMissingCompiledDependency();

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "Error: NemoClaw's compiled CLI could not start because a required module is unavailable. " +
        "Rerun the installer command that you used to install NemoClaw; if the problem continues, report the startup failure.\n",
    );
    expect(result.stderr).not.toContain("/private/nemoclaw-secret-dependency");
    expect(result.stderr).not.toContain("Cannot find module");
    expect(result.stderr).not.toContain("An install or upgrade did not finish.");
  });
});

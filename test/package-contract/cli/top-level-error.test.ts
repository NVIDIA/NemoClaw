// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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
const uninstallPath = path.join(REPO_ROOT, "uninstall.sh");

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

function runWithCapturedGatewayPort(
  home: string,
  explicitPort?: string,
  overrides: NodeJS.ProcessEnv = {},
): SpawnSyncReturns<string> {
  const env = {
    ...process.env,
    ...overrides,
    HOME: home,
    NEMOCLAW_GATEWAY_PORT: explicitPort ?? "",
  };
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
    process.stdout.write(
      String(process.env.NEMOCLAW_GATEWAY_PORT || "") +
        ":" +
        String(process.env._NEMOCLAW_AUTOMATIC_GATEWAY_PORT || ""),
    );
    return { mainPromise: Promise.resolve() };
  }
  return originalLoad.apply(this, arguments);
};
require(cliPath);`,
    ],
    { cwd: REPO_ROOT, encoding: "utf-8", env, timeout: 5_000 },
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

  it("restores an automatically selected gateway port for later CLI commands (#10824)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-automatic-port-"));
    try {
      const marker = path.join(home, ".nemoclaw", "gateways", "8990", "automatic-gateway-port");
      fs.mkdirSync(path.dirname(marker), { recursive: true });
      fs.writeFileSync(marker, "8990\n");

      const result = runWithCapturedGatewayPort(home);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("8990:1");
      expect(result.stderr).toBe("");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("restores a pending automatic port so interrupted onboarding can resume (#10824)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-pending-port-"));
    try {
      const marker = path.join(
        home,
        ".nemoclaw",
        "gateways",
        "8990",
        "automatic-gateway-port.pending",
      );
      fs.mkdirSync(path.dirname(marker), { recursive: true });
      fs.writeFileSync(marker, "8990\n");

      const result = runWithCapturedGatewayPort(home);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("8990:1");
      expect(result.stderr).toBe("");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("consumes pending and completed markers produced by the installer (#10824)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-installer-marker-"));
    try {
      const pending = spawnSync(
        "bash",
        [
          "-c",
          `source ${JSON.stringify(path.join(REPO_ROOT, "scripts", "install.sh"))}
NEMOCLAW_GATEWAY_PORT=8990
export NEMOCLAW_GATEWAY_PORT
persist_pending_automatic_gateway_port_selection`,
        ],
        { cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env, HOME: home } },
      );
      expect(pending.status, pending.stderr).toBe(0);
      expect(runWithCapturedGatewayPort(home).stdout).toBe("8990:1");

      const completed = spawnSync(
        "bash",
        [
          "-c",
          `source ${JSON.stringify(path.join(REPO_ROOT, "scripts", "install.sh"))}
NEMOCLAW_GATEWAY_PORT=8990
export NEMOCLAW_GATEWAY_PORT
complete_automatic_gateway_port_selection`,
        ],
        { cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env, HOME: home } },
      );
      expect(completed.status, completed.stderr).toBe(0);
      expect(runWithCapturedGatewayPort(home).stdout).toBe("8990:1");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("preserves an explicit gateway port over an automatic marker (#10824)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-explicit-port-"));
    try {
      const marker = path.join(home, ".nemoclaw", "gateways", "8990", "automatic-gateway-port");
      fs.mkdirSync(path.dirname(marker), { recursive: true });
      fs.writeFileSync(marker, "8990\n");

      const result = runWithCapturedGatewayPort(home, "9123");

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("9123:");
      expect(result.stderr).toBe("");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("clears reserved automatic provenance for an operator-provided gateway port (#10824)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-installer-port-"));
    try {
      const result = runWithCapturedGatewayPort(home, "8990", {
        _NEMOCLAW_AUTOMATIC_GATEWAY_PORT: "1",
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("8990:");
      expect(result.stderr).toBe("");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("preserves installer-provided automatic provenance for onboarding completion (#10824)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-installer-port-"));
    try {
      const result = runWithCapturedGatewayPort(home, "8990", {
        NEMOCLAW_INSTALLING: "1",
        _NEMOCLAW_AUTOMATIC_GATEWAY_PORT: "1",
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("8990:1");
      expect(result.stderr).toBe("");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects ambiguous automatic gateway markers before loading the CLI (#10824)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-ambiguous-port-"));
    try {
      const firstMarker = path.join(
        home,
        ".nemoclaw",
        "gateways",
        "8990",
        "automatic-gateway-port",
      );
      const secondMarker = path.join(
        home,
        ".nemoclaw",
        "gateways",
        "8991",
        "automatic-gateway-port",
      );
      fs.mkdirSync(path.dirname(firstMarker), { recursive: true });
      fs.mkdirSync(path.dirname(secondMarker), { recursive: true });
      fs.writeFileSync(firstMarker, "8990\n");
      fs.writeFileSync(secondMarker, "8991\n");

      const result = runWithCapturedGatewayPort(home);

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(
        "Could not safely resolve the automatically selected NemoClaw gateway port",
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects a FIFO automatic gateway marker without blocking CLI startup (#10824)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-fifo-port-"));
    try {
      const marker = path.join(home, ".nemoclaw", "gateways", "8990", "automatic-gateway-port");
      fs.mkdirSync(path.dirname(marker), { recursive: true });
      const fifo = spawnSync("mkfifo", [marker], { encoding: "utf8" });
      expect(fifo.status, fifo.stderr).toBe(0);

      const result = runWithCapturedGatewayPort(home);

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(
        "Could not safely resolve the automatically selected NemoClaw gateway port",
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects an automatic gateway marker with extra trailing bytes (#10824)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-marker-bytes-"));
    try {
      const marker = path.join(home, ".nemoclaw", "gateways", "8990", "automatic-gateway-port");
      fs.mkdirSync(path.dirname(marker), { recursive: true });
      fs.writeFileSync(marker, "8990\n\n");

      const result = runWithCapturedGatewayPort(home);

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(
        "Could not safely resolve the automatically selected NemoClaw gateway port",
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects an automatic gateway marker below a group-writable ancestor (#10824)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-writable-root-"));
    try {
      const gateways = path.join(home, ".nemoclaw", "gateways");
      const marker = path.join(gateways, "8990", "automatic-gateway-port");
      fs.mkdirSync(path.dirname(marker), { recursive: true, mode: 0o700 });
      fs.writeFileSync(marker, "8990\n", { mode: 0o600 });
      fs.chmodSync(gateways, 0o770);

      const result = runWithCapturedGatewayPort(home);

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(
        "Could not safely resolve the automatically selected NemoClaw gateway port",
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects a group-writable automatic gateway marker file (#10824)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-writable-marker-"));
    try {
      const marker = path.join(home, ".nemoclaw", "gateways", "8990", "automatic-gateway-port");
      fs.mkdirSync(path.dirname(marker), { recursive: true, mode: 0o700 });
      fs.writeFileSync(marker, "8990\n", { mode: 0o660 });
      fs.chmodSync(marker, 0o660);

      const result = runWithCapturedGatewayPort(home);

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(
        "Could not safely resolve the automatically selected NemoClaw gateway port",
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("ignores an inherited BASH_ENV while resolving an automatic marker (#10824)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-bash-env-port-"));
    try {
      const marker = path.join(home, ".nemoclaw", "gateways", "8990", "automatic-gateway-port");
      const bashEnv = path.join(home, "hostile-bash-env.sh");
      const sentinel = path.join(home, "bash-env-ran");
      fs.mkdirSync(path.dirname(marker), { recursive: true });
      fs.writeFileSync(marker, "8990\n");
      fs.writeFileSync(bashEnv, 'printf "executed\\n" >"$BASH_ENV_SENTINEL"\n');

      const result = runWithCapturedGatewayPort(home, undefined, {
        BASH_ENV: bashEnv,
        BASH_ENV_SENTINEL: sentinel,
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("8990:1");
      expect(fs.existsSync(sentinel)).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("restores an automatic gateway port through the direct uninstall wrapper (#10824)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-direct-uninstall-port-"));
    try {
      const packageRoot = path.join(tmp, "package");
      const home = path.join(tmp, "home");
      const capture = path.join(tmp, "uninstall-capture");
      const marker = path.join(
        home,
        ".nemoclaw",
        "gateways",
        "8990",
        "automatic-gateway-port",
      );
      fs.mkdirSync(path.join(packageRoot, "bin"), { recursive: true });
      fs.mkdirSync(path.join(packageRoot, "scripts"), { recursive: true });
      fs.mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
      fs.mkdirSync(path.dirname(marker), { recursive: true, mode: 0o700 });
      fs.copyFileSync(uninstallPath, path.join(packageRoot, "uninstall.sh"));
      fs.copyFileSync(path.join(REPO_ROOT, "bin", "nemoclaw.js"), path.join(packageRoot, "bin", "nemoclaw.js"));
      fs.copyFileSync(path.join(REPO_ROOT, "scripts", "install.sh"), path.join(packageRoot, "scripts", "install.sh"));
      fs.writeFileSync(marker, "8990\n", { mode: 0o600 });
      fs.writeFileSync(
        path.join(packageRoot, "dist", "nemoclaw.js"),
        `const fs = require("node:fs");
fs.writeFileSync(
  process.env.UNINSTALL_CAPTURE,
  [
    process.env.NEMOCLAW_GATEWAY_PORT || "",
    process.env._NEMOCLAW_AUTOMATIC_GATEWAY_PORT || "",
    process.argv.slice(2).join(" "),
  ].join(":"),
);
exports.mainPromise = Promise.resolve();
`,
      );
      const cleanEnv = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith("NEMOCLAW_")),
      );

      const result = spawnSync("bash", [path.join(packageRoot, "uninstall.sh"), "--yes"], {
        encoding: "utf8",
        env: {
          ...cleanEnv,
          HOME: home,
          PATH: "/usr/bin:/bin",
          NEMOCLAW_NODE: process.execPath,
          UNINSTALL_CAPTURE: capture,
        },
      });

      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(fs.readFileSync(capture, "utf8")).toBe("8990:1:internal uninstall run-plan --yes");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Regression tests for SSH identity drift after host reboot.
// Covers: https://github.com/NVIDIA/NemoClaw/issues/2056
//
// Simulates the post-reboot scenario where the gateway restarts with new SSH
// keys, causing "handshake verification failed" errors. Verifies:
//   1. The registry recovery gate triggers for bare `nemoclaw <name>` (no action)
//   2. Identity drift is detected and surfaced (current behavior)
//
// Once the fix for #2056 lands, update these tests to assert auto-recovery.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tmpFixtures: string[] = [];

afterEach(() => {
  for (const dir of tmpFixtures.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Build a temp HOME with a NemoClaw registry and a fake openshell binary.
 *
 * @param sandboxName - name of the sandbox in the registry
 * @param mode - "healthy" | "identity_drift" | "gateway_down"
 */
function setupFixture(sandboxName: string, mode: "healthy" | "identity_drift" | "gateway_down") {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-reboot-"));
  tmpFixtures.push(tmpDir);
  const homeLocalBin = path.join(tmpDir, ".local", "bin");
  const registryDir = path.join(tmpDir, ".nemoclaw");
  const openshellPath = path.join(homeLocalBin, "openshell");

  fs.mkdirSync(homeLocalBin, { recursive: true });
  fs.mkdirSync(registryDir, { recursive: true });

  fs.writeFileSync(
    path.join(registryDir, "sandboxes.json"),
    JSON.stringify({
      defaultSandbox: sandboxName,
      sandboxes: {
        [sandboxName]: {
          name: sandboxName,
          model: "nvidia/test-model",
          provider: "nvidia-prod",
          gpuEnabled: false,
          policies: [],
        },
      },
    }),
    { mode: 0o600 },
  );

  // Fake openshell binary that simulates post-reboot states
  const handshakeError =
    "ssh: handshake verification failed — gateway identity has changed since last connection";

  let sandboxGetBehavior: string;
  let statusBehavior: string;
  let gatewayInfoBehavior: string;
  let gatewayStartBehavior: string;

  switch (mode) {
    case "healthy":
      statusBehavior = `process.stdout.write("Gateway: nemoclaw\\nStatus: Connected\\n"); process.exit(0);`;
      gatewayInfoBehavior = `process.stdout.write("Gateway: nemoclaw\\nGateway endpoint: https://127.0.0.1:8080\\n"); process.exit(0);`;
      sandboxGetBehavior = `process.stdout.write("Sandbox:\\n\\n  Id: abc\\n  Name: ${sandboxName}\\n  Phase: Ready\\n"); process.exit(0);`;
      gatewayStartBehavior = `process.exit(0);`;
      break;
    case "identity_drift":
      // Gateway is running but SSH keys have changed — sandbox commands fail
      statusBehavior = `process.stdout.write("Gateway: nemoclaw\\nStatus: Connected\\n"); process.exit(0);`;
      gatewayInfoBehavior = `process.stdout.write("Gateway: nemoclaw\\nGateway endpoint: https://127.0.0.1:8080\\n"); process.exit(0);`;
      sandboxGetBehavior = `process.stderr.write("${handshakeError}\\n"); process.exit(1);`;
      gatewayStartBehavior = `process.exit(0);`;
      break;
    case "gateway_down":
      // Gateway container is not running — simulates post-reboot before recovery
      statusBehavior = `process.stdout.write("No gateway configured\\n"); process.exit(1);`;
      gatewayInfoBehavior = `process.stdout.write("No gateway metadata found\\n"); process.exit(1);`;
      sandboxGetBehavior = `process.stderr.write("Connection refused\\n"); process.exit(1);`;
      gatewayStartBehavior = `process.exit(0);`;
      break;
  }

  fs.writeFileSync(
    openshellPath,
    `#!${process.execPath}
const args = process.argv.slice(2);

if (args[0] === "status") {
  ${statusBehavior}
}

if (args[0] === "gateway" && args[1] === "info") {
  ${gatewayInfoBehavior}
}

if (args[0] === "gateway" && args[1] === "start") {
  ${gatewayStartBehavior}
}

if (args[0] === "gateway" && args[1] === "select") {
  process.exit(0);
}

if (args[0] === "sandbox" && args[1] === "get" && args[2] === ${JSON.stringify(sandboxName)}) {
  ${sandboxGetBehavior}
}

if (args[0] === "sandbox" && args[1] === "list") {
  process.stdout.write("${sandboxName}\\n");
  process.exit(0);
}

if (args[0] === "sandbox" && args[1] === "connect") {
  process.exit(0);
}

if (args[0] === "policy" && args[1] === "get") {
  process.exit(1);
}

if (args[0] === "inference" && args[1] === "get") {
  process.stdout.write("Gateway inference:\\n  Provider: nvidia-prod\\n  Model: nvidia/test-model\\n");
  process.exit(0);
}

if (args[0] === "forward") {
  process.exit(0);
}

if (args[0] === "logs") {
  process.exit(0);
}

process.exit(0);
`,
    { mode: 0o755 },
  );

  return { tmpDir, sandboxName };
}

/**
 * Simulates a cleared/corrupt registry (sandbox entry missing) where the
 * gateway is still live. The recovery gate should attempt to rebuild the
 * registry from the live gateway for both explicit and bare commands.
 */
function setupEmptyRegistry(sandboxName: string) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-reboot-noreg-"));
  tmpFixtures.push(tmpDir);
  const homeLocalBin = path.join(tmpDir, ".local", "bin");
  const registryDir = path.join(tmpDir, ".nemoclaw");
  const openshellPath = path.join(homeLocalBin, "openshell");

  fs.mkdirSync(homeLocalBin, { recursive: true });
  fs.mkdirSync(registryDir, { recursive: true });

  // Empty registry — no sandboxes known
  fs.writeFileSync(
    path.join(registryDir, "sandboxes.json"),
    JSON.stringify({ defaultSandbox: null, sandboxes: {} }),
    { mode: 0o600 },
  );

  // Fake openshell — gateway is healthy and sandbox is live
  fs.writeFileSync(
    openshellPath,
    `#!${process.execPath}
const args = process.argv.slice(2);

if (args[0] === "status") {
  process.stdout.write("Gateway: nemoclaw\\nStatus: Connected\\n");
  process.exit(0);
}

if (args[0] === "gateway" && args[1] === "info") {
  process.stdout.write("Gateway: nemoclaw\\nGateway endpoint: https://127.0.0.1:8080\\n");
  process.exit(0);
}

if (args[0] === "gateway" && args[1] === "select") {
  process.exit(0);
}

if (args[0] === "gateway" && args[1] === "start") {
  process.exit(0);
}

if (args[0] === "sandbox" && args[1] === "get" && args[2] === ${JSON.stringify(sandboxName)}) {
  process.stdout.write("Sandbox:\\n\\n  Id: abc\\n  Name: ${sandboxName}\\n  Phase: Ready\\n");
  process.exit(0);
}

if (args[0] === "sandbox" && args[1] === "list") {
  process.stdout.write("${sandboxName}\\n");
  process.exit(0);
}

if (args[0] === "sandbox" && args[1] === "connect") {
  process.exit(0);
}

if (args[0] === "policy" && args[1] === "get") {
  process.exit(1);
}

if (args[0] === "inference" && args[1] === "get") {
  process.stdout.write("Gateway inference:\\n  Provider: nvidia-prod\\n  Model: nvidia/test-model\\n");
  process.exit(0);
}

if (args[0] === "forward") {
  process.exit(0);
}

if (args[0] === "logs") {
  process.exit(0);
}

process.exit(0);
`,
    { mode: 0o755 },
  );

  return { tmpDir, sandboxName };
}

function runCli(tmpDir: string, args: string[]) {
  const repoRoot = path.join(import.meta.dirname, "..");
  return spawnSync(process.execPath, [path.join(repoRoot, "bin", "nemoclaw.js"), ...args], {
    cwd: repoRoot,
    encoding: "utf-8",
    env: {
      ...process.env,
      HOME: tmpDir,
      PATH: "/usr/bin:/bin",
      NEMOCLAW_NO_CONNECT_HINT: "1",
    },
    timeout: Number(process.env.NEMOCLAW_EXEC_TIMEOUT || 15_000),
  });
}

describe("post-reboot SSH identity drift (#2056)", () => {
  it(
    "bare `nemoclaw <name>` (no action) resolves to connect and finds registry entry",
    { timeout: Number(process.env.NEMOCLAW_TEST_TIMEOUT || 20_000) },
    () => {
      const { tmpDir, sandboxName } = setupFixture("reboot-test", "healthy");
      const result = runCli(tmpDir, [sandboxName]);
      expect(result.status).toBe(0);
    },
  );

  it(
    "explicit `nemoclaw <name> connect` works for healthy sandbox",
    { timeout: Number(process.env.NEMOCLAW_TEST_TIMEOUT || 20_000) },
    () => {
      const { tmpDir, sandboxName } = setupFixture("reboot-explicit", "healthy");
      const result = runCli(tmpDir, [sandboxName, "connect"]);
      expect(result.status).toBe(0);
    },
  );

  it(
    "identity drift is detected when gateway SSH keys have changed",
    { timeout: Number(process.env.NEMOCLAW_TEST_TIMEOUT || 20_000) },
    () => {
      const { tmpDir, sandboxName } = setupFixture("drift-sandbox", "identity_drift");
      const result = runCli(tmpDir, [sandboxName, "connect"]);
      const combined = (result.stdout || "") + (result.stderr || "");
      expect(combined).toMatch(/identity|handshake|drift|changed/i);
      expect(result.status).not.toBe(0);
    },
  );

  it(
    "bare `nemoclaw <name>` also detects identity drift (not silent failure)",
    { timeout: Number(process.env.NEMOCLAW_TEST_TIMEOUT || 20_000) },
    () => {
      const { tmpDir, sandboxName } = setupFixture("drift-bare", "identity_drift");
      const result = runCli(tmpDir, [sandboxName]);
      const combined = (result.stdout || "") + (result.stderr || "");
      expect(combined).not.toMatch(/unknown command/i);
      expect(result.status).not.toBe(0);
    },
  );
});

describe("post-reboot registry recovery gate (#2056)", () => {
  it(
    "explicit `nemoclaw <name> connect` recovers registry from live gateway",
    { timeout: Number(process.env.NEMOCLAW_TEST_TIMEOUT || 20_000) },
    () => {
      const { tmpDir, sandboxName } = setupEmptyRegistry("orphan-explicit");
      const result = runCli(tmpDir, [sandboxName, "connect"]);
      expect(result.status).toBe(0);
    },
  );

  it(
    "bare `nemoclaw <name>` recovers registry from live gateway",
    { timeout: Number(process.env.NEMOCLAW_TEST_TIMEOUT || 20_000) },
    () => {
      const { tmpDir, sandboxName } = setupEmptyRegistry("orphan-bare");
      const result = runCli(tmpDir, [sandboxName]);
      const combined = (result.stdout || "") + (result.stderr || "");
      expect(combined).not.toMatch(/unknown command/i);
      expect(result.status).toBe(0);
    },
  );
});

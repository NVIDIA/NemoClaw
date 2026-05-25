// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execTimeout, testTimeoutOptions } from "./helpers/timeouts";

const tmpFixtures: string[] = [];

afterEach(() => {
  for (const dir of tmpFixtures.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function setupFixture(sandboxName: string, phase: string) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-stuck-"));
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

  // Fake openshell binary — reports sandbox in the specified phase
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

if (args[0] === "sandbox" && args[1] === "get" && args[2] === ${JSON.stringify(sandboxName)}) {
  process.stdout.write("Sandbox:\\n\\n  Id: abc\\n  Name: ${sandboxName}\\n  Phase: ${phase}\\n");
  process.exit(0);
}

if (args[0] === "sandbox" && args[1] === "list") {
  process.stdout.write("${sandboxName}   ${phase}   1m ago\\n");
  process.exit(0);
}

if (args[0] === "policy" && args[1] === "get") {
  process.exit(1);
}

if (args[0] === "inference" && args[1] === "get") {
  process.stdout.write("Gateway inference:\\n  Provider: nvidia-prod\\n  Model: nvidia/test-model\\n");
  process.exit(0);
}

if (args[0] === "sandbox" && args[1] === "connect") {
  process.exit(0);
}

if (args[0] === "logs") {
  process.exit(0);
}

if (args[0] === "forward") {
  process.exit(0);
}

process.exit(0);
`,
    { mode: 0o755 },
  );

  return { tmpDir, sandboxName };
}

function runCli(
  tmpDir: string,
  sandboxName: string,
  subcommand: string,
  extraEnv: Record<string, string> = {},
) {
  const repoRoot = path.join(import.meta.dirname, "..");
  return spawnSync(
    process.execPath,
    [path.join(repoRoot, "bin", "nemoclaw.js"), sandboxName, subcommand],
    {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        PATH: "/usr/bin:/bin",
        NEMOCLAW_NO_CONNECT_HINT: "1",
        ...extraEnv,
      },
      timeout: execTimeout(15_000),
    },
  );
}

describe("sandbox stuck in non-Ready phase (#2016)", () => {
  it(
    "connect times out with guidance when sandbox is stuck in Provisioning",
    testTimeoutOptions(20_000),
    () => {
      const { tmpDir, sandboxName } = setupFixture("stuck-sandbox", "Provisioning");

      // Short connect timeout so the test doesn't wait 120s. Provisioning
      // is not a terminal state, so the readiness poll introduced in #466
      // waits until NEMOCLAW_CONNECT_TIMEOUT elapses.
      const result = runCli(tmpDir, sandboxName, "connect", {
        NEMOCLAW_CONNECT_TIMEOUT: "3",
      });
      expect(result.status).not.toBe(0);

      const combined = (result.stdout || "") + (result.stderr || "");
      expect(combined).toContain(`Waiting for sandbox '${sandboxName}' to be ready`);
      expect(combined).toContain("Timed out");
      expect(combined).toContain("NEMOCLAW_CONNECT_TIMEOUT");
    },
  );

  it(
    "connect exits immediately with recovery hint when sandbox is in a terminal failure state",
    testTimeoutOptions(20_000),
    () => {
      const { tmpDir, sandboxName } = setupFixture("failed-sandbox", "Failed");

      const result = runCli(tmpDir, sandboxName, "connect");
      expect(result.status).not.toBe(0);

      const combined = (result.stdout || "") + (result.stderr || "");
      expect(combined).toContain("is in 'Failed' state");
      expect(combined).toContain(`nemoclaw ${sandboxName} logs --follow`);
      expect(combined).toContain(`nemoclaw ${sandboxName} status`);
    },
  );

  it(
    "status shows recovery hint when sandbox is stuck in Provisioning",
    testTimeoutOptions(20_000),
    () => {
      const { tmpDir, sandboxName } = setupFixture("stuck-status", "Provisioning");

      const result = runCli(tmpDir, sandboxName, "status");
      const combined = (result.stdout || "") + (result.stderr || "");
      expect(combined).toContain("stuck in 'Provisioning' phase");
      expect(combined).toContain(`nemoclaw ${sandboxName} rebuild --yes`);
    },
  );

  it("connect succeeds when sandbox phase is Ready", testTimeoutOptions(20_000), () => {
    const { tmpDir, sandboxName } = setupFixture("ready-sandbox", "Ready");

    const result = runCli(tmpDir, sandboxName, "connect");
    expect(result.status).toBe(0);

    const combined = (result.stdout || "") + (result.stderr || "");
    expect(combined).not.toContain("stuck in");
  });
});

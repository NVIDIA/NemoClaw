// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Tests for #1248 — inference route swap on sandbox connect.
 *
 * Each test creates a fake openshell binary that records calls to a state
 * file, sets up a sandbox registry, and spawns the real CLI entrypoint.
 */

function setupFixture(
  sandboxEntry: Record<string, unknown>,
  liveInferenceProvider: string | null,
  liveInferenceModel: string | null,
) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-inf-swap-"));
  const homeLocalBin = path.join(tmpDir, ".local", "bin");
  const registryDir = path.join(tmpDir, ".nemoclaw");
  const stateFile = path.join(tmpDir, "state.json");
  const openshellPath = path.join(homeLocalBin, "openshell");
  const sandboxName = String(sandboxEntry.name);

  fs.mkdirSync(homeLocalBin, { recursive: true });
  fs.mkdirSync(registryDir, { recursive: true });

  fs.writeFileSync(
    path.join(registryDir, "sandboxes.json"),
    JSON.stringify({
      defaultSandbox: sandboxName,
      sandboxes: { [sandboxName]: sandboxEntry },
    }),
    { mode: 0o600 },
  );

  // Build the Gateway inference section for `openshell inference get`
  let inferenceBlock;
  if (liveInferenceProvider && liveInferenceModel) {
    inferenceBlock = `Gateway inference:\\n  Provider: ${liveInferenceProvider}\\n  Model: ${liveInferenceModel}\\n`;
  } else {
    inferenceBlock = `Gateway inference:\\n  Not configured\\n`;
  }

  fs.writeFileSync(stateFile, JSON.stringify({ inferenceSetCalls: [] }));

  // Fake openshell binary — records inference set calls, stubs everything else
  fs.writeFileSync(
    openshellPath,
    `#!${process.execPath}
const fs = require("fs");
const args = process.argv.slice(2);
const stateFile = ${JSON.stringify(stateFile)};
const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));

if (args[0] === "status") {
  process.stdout.write("Gateway: nemoclaw\\nStatus: Connected\\n");
  process.exit(0);
}

if (args[0] === "gateway" && args[1] === "info") {
  process.stdout.write("Gateway: nemoclaw\\nGateway endpoint: https://127.0.0.1:8080\\n");
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
  // Don't actually drop into a shell — just exit successfully
  process.exit(0);
}

if (args[0] === "inference" && args[1] === "get") {
  process.stdout.write(${JSON.stringify(inferenceBlock.replace(/\\n/g, "\n"))});
  process.exit(0);
}

if (args[0] === "inference" && args[1] === "set") {
  state.inferenceSetCalls.push(args.slice(2));
  fs.writeFileSync(stateFile, JSON.stringify(state));
  process.exit(0);
}

if (args[0] === "logs") {
  process.exit(0);
}

if (args[0] === "forward") {
  process.exit(0);
}

// Default — succeed silently
process.exit(0);
`,
    { mode: 0o755 },
  );

  return { tmpDir, stateFile, sandboxName };
}

function runConnect(tmpDir: string, sandboxName: string) {
  const repoRoot = path.join(import.meta.dirname, "..");
  return spawnSync(
    process.execPath,
    [path.join(repoRoot, "bin", "nemoclaw.js"), sandboxName, "connect"],
    {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        PATH: "/usr/bin:/bin",
        NEMOCLAW_NO_CONNECT_HINT: "1",
      },
      timeout: Number(process.env.NEMOCLAW_EXEC_TIMEOUT || 15_000),
    },
  );
}

describe("sandbox connect inference route swap (#1248)", () => {
  it(
    "swaps inference route when live route does not match sandbox provider",
    { timeout: Number(process.env.NEMOCLAW_TEST_TIMEOUT || 20_000) },
    () => {
      const { tmpDir, stateFile, sandboxName } = setupFixture(
        {
          name: "my-sandbox",
          model: "claude-sonnet-4-20250514",
          provider: "anthropic-prod",
          gpuEnabled: false,
          policies: [],
        },
        "nvidia-prod", // live route points to a different provider
        "nvidia/nemotron-3-super-120b-a12b",
      );

      const result = runConnect(tmpDir, sandboxName);
      expect(result.status).toBe(0);

      const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      expect(state.inferenceSetCalls.length).toBe(1);
      expect(state.inferenceSetCalls[0]).toEqual([
        "--provider",
        "anthropic-prod",
        "--model",
        "claude-sonnet-4-20250514",
        "--no-verify",
      ]);

      // Verify the notice was printed
      const combined = (result.stdout || "") + (result.stderr || "");
      expect(combined).toContain("Switching inference route to anthropic-prod/claude-sonnet-4-20250514");
    },
  );

  it(
    "does not swap inference route for legacy sandbox without provider",
    { timeout: Number(process.env.NEMOCLAW_TEST_TIMEOUT || 20_000) },
    () => {
      const { tmpDir, stateFile, sandboxName } = setupFixture(
        {
          name: "legacy-sandbox",
          gpuEnabled: false,
          policies: [],
          // No provider or model — pre-v0.0.18 sandbox
        },
        "nvidia-prod",
        "nvidia/nemotron-3-super-120b-a12b",
      );

      const result = runConnect(tmpDir, sandboxName);
      expect(result.status).toBe(0);

      const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      expect(state.inferenceSetCalls.length).toBe(0);
    },
  );

  it(
    "does not swap when live route already matches sandbox provider",
    { timeout: Number(process.env.NEMOCLAW_TEST_TIMEOUT || 20_000) },
    () => {
      const { tmpDir, stateFile, sandboxName } = setupFixture(
        {
          name: "matched-sandbox",
          model: "nvidia/nemotron-3-super-120b-a12b",
          provider: "nvidia-prod",
          gpuEnabled: false,
          policies: [],
        },
        "nvidia-prod",
        "nvidia/nemotron-3-super-120b-a12b",
      );

      const result = runConnect(tmpDir, sandboxName);
      expect(result.status).toBe(0);

      const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      expect(state.inferenceSetCalls.length).toBe(0);
    },
  );
});

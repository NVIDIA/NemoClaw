// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testTimeoutOptions } from "../helpers/timeouts";

const CLI = path.join(import.meta.dirname, "../..", "bin", "nemoclaw.js");
const SANDBOX = "issue-9104-alpha";

describe("inference set sandbox configuration read failures", () => {
  let home: string;
  let openshell: string;
  let openshellLog: string;
  let registryFile: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-9104-"));
    openshell = path.join(home, "openshell");
    openshellLog = path.join(home, "openshell.log");
    fs.writeFileSync(
      openshell,
      [
        "#!/usr/bin/env bash",
        `printf '%s\\n' "$*" >> ${JSON.stringify(openshellLog)}`,
        "printf '%s\\n' 'exec session setup failed: container not ready' >&2",
        "exit 1",
      ].join("\n"),
      { mode: 0o755 },
    );

    const registryDir = path.join(home, ".nemoclaw");
    fs.mkdirSync(registryDir, { recursive: true });
    registryFile = path.join(registryDir, "sandboxes.json");
    fs.writeFileSync(
      registryFile,
      JSON.stringify({
        sandboxes: {
          [SANDBOX]: {
            agent: "openclaw",
            gpuEnabled: false,
            model: "nvidia/llama-3.3-nemotron-super-49b-v1",
            name: SANDBOX,
            provider: "nvidia-prod",
          },
        },
        defaultSandbox: SANDBOX,
      }),
      { mode: 0o600 },
    );
  });

  afterEach(() => {
    fs.rmSync(home, { force: true, recursive: true });
  });

  it.each([
    [
      "global",
      [
        "inference",
        "set",
        "--provider",
        "nvidia-prod",
        "--model",
        "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
        "--sandbox",
        SANDBOX,
        "--no-verify",
      ],
    ],
    [
      "sandbox-first",
      [
        SANDBOX,
        "inference",
        "set",
        "--provider",
        "nvidia-prod",
        "--model",
        "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
        "--no-verify",
      ],
    ],
  ])(
    "%s inference set exits with status 1 when OpenShell cannot read the sandbox configuration (#9104)",
    testTimeoutOptions(30_000),
    (_grammar, argv) => {
      const registryBefore = fs.readFileSync(registryFile, "utf8");
      const result = spawnSync(process.execPath, [CLI, ...argv], {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          NEMOCLAW_OPENSHELL_BIN: openshell,
          NEMOCLAW_STATUS_PROBE_TIMEOUT_MS: "2000",
          NEMOCLAW_TEST_NO_SLEEP: "1",
        },
        killSignal: "SIGKILL",
        timeout: 30_000,
      });
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;

      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(output).toContain("Cannot read openclaw config (/sandbox/.openclaw/openclaw.json)");
      expect(output).not.toContain("Setting OpenShell inference route");
      expect(fs.readFileSync(registryFile, "utf8")).toBe(registryBefore);
      const openshellCalls = fs.readFileSync(openshellLog, "utf8").trim().split("\n");
      expect(openshellCalls).toHaveLength(1);
      expect(openshellCalls[0]).toContain("sandbox exec");
      expect(openshellCalls[0]).toContain("cat /sandbox/.openclaw/openclaw.json");
      expect(openshellCalls).not.toContainEqual(expect.stringMatching(/\binference set\b/u));
      expect(result.status).toBe(1);
    },
  );
});

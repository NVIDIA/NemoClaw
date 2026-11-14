// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, test, vi } from "vitest";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { captureSandboxFailureDiagnostics } from "../fixtures/sandbox-failure-diagnostics.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

const CONTAINER = "a".repeat(64);
const SUCCESS: ShellProbeResult = {
  command: [],
  exitCode: 0,
  signal: null,
  timedOut: false,
  stdout: CONTAINER,
  stderr: "",
  artifacts: { stdout: "", stderr: "", result: "" },
};

describe("OpenClaw ownership failure evidence", () => {
  test("bounds file reads, redacts payloads and preserves process identity", () => {
    const result = spawnSync(
      "python3",
      ["-I", "-B", fileURLToPath(new URL("./openclaw-owner-diagnostic-cases.py", import.meta.url))],
      {
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  });

  test.for([
    { exitCode: 0, timedOut: false, enabled: true, commands: 0, owners: 0 },
    { exitCode: 1, timedOut: false, enabled: false, commands: 5, owners: 0 },
    { exitCode: 1, timedOut: false, enabled: true, commands: 6, owners: 1 },
    { exitCode: null, timedOut: true, enabled: true, commands: 6, owners: 1 },
  ])("collects only opted-in failures: %j", async ({ enabled, commands, owners, ...result }) => {
    const command = vi.fn<HostCliClient["command"]>().mockResolvedValue(SUCCESS);
    await captureSandboxFailureDiagnostics(
      { command, openshellCommandPath: "/reviewed/openshell" },
      result,
      {
        sandboxName: "selected-openclaw",
        artifactPrefix: "readiness",
        captureOpenClawOwner: enabled,
        redactionValues: ["fixture-secret"],
        env: {
          HOME: "/fixture/home",
          NEMOCLAW_GATEWAY_RUNTIME: "docker",
          OPENSHELL_GATEWAY: "selected-gateway",
        },
      },
    );
    const observations = command.mock.calls.filter(
      ([, , options]) => options?.artifactName === "readiness-native-owner",
    );
    expect(command).toHaveBeenCalledTimes(commands);
    expect(observations).toHaveLength(owners);
  });

  test.for(["reject", "timeout"] as const)(
    "keeps the readiness failure when owner collection has a %s",
    async (mode) => {
      const command = vi.fn<HostCliClient["command"]>().mockResolvedValue(SUCCESS);
      command.mockImplementation(async (_binary, _args, options) => {
        switch (options?.artifactName) {
          case "readiness-native-owner":
            switch (mode) {
              case "reject":
                throw new Error("exec unavailable");
              case "timeout":
                return { ...SUCCESS, exitCode: null, timedOut: true };
            }
          default:
            return SUCCESS;
        }
      });
      const failure = { exitCode: 1, timedOut: false };
      await expect(
        captureSandboxFailureDiagnostics(
          { command, openshellCommandPath: "/reviewed/openshell" },
          failure,
          {
            sandboxName: "selected-openclaw",
            artifactPrefix: "readiness",
            captureOpenClawOwner: true,
            redactionValues: ["fixture-secret"],
            env: {
              HOME: "/fixture/home",
              NEMOCLAW_GATEWAY_RUNTIME: "docker",
              OPENSHELL_GATEWAY: "selected-gateway",
            },
          },
        ),
      ).resolves.toBeUndefined();
      expect(failure).toEqual({ exitCode: 1, timedOut: false });
      const owner = command.mock.calls.find(
        ([, , options]) => options?.artifactName === "readiness-native-owner",
      );
      expect(owner?.[0]).toBe("docker");
      expect(owner?.[1]).toEqual([
        "exec",
        CONTAINER,
        "python3",
        "-I",
        "-c",
        expect.any(String),
        "--state-root",
        "/sandbox/.openclaw",
      ]);
      expect(owner?.[2]).toMatchObject({
        timeoutMs: 10_000,
        captureLimitBytes: 32_768,
        redactionValues: ["fixture-secret"],
      });
      const artifacts = command.mock.calls.map(([, , options]) => options?.artifactName);
      expect(artifacts).toContain("readiness-container-state");
      expect(artifacts).toContain("readiness-startup-log");
      expect(artifacts.indexOf("readiness-native-owner")).toBeLessThan(
        artifacts.indexOf("readiness-supervisor-logs"),
      );
    },
  );
});

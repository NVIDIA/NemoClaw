// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ArtifactSink } from "../fixtures/artifacts.ts";
import { HostCliClient } from "../fixtures/clients/host.ts";
import { CleanupRegistry } from "../fixtures/cleanup.ts";
import { SecretStore } from "../fixtures/secrets.ts";
import type {
  ShellProbeResult,
  ShellProbeRunOptions,
  TrustedShellCommand,
} from "../fixtures/shell-probe.ts";
import { runE2eCloudExperimentalChecks } from "../live/cloud-experimental-checks.ts";

function shellResult(exitCode: number, stdout: string, stderr = ""): ShellProbeResult {
  return {
    command: [],
    exitCode,
    signal: null,
    timedOut: false,
    stdout,
    stderr,
    artifacts: {
      stdout: "stdout.txt",
      stderr: "stderr.txt",
      result: "result.json",
    },
  };
}

describe("Cloud experimental TUI caller recovery", () => {
  it.each(
    [
      "test/e2e/e2e-cloud-experimental/checks/10-deepagents-code-tui-startup.sh",
      "test/e2e/e2e-cloud-experimental/checks/12-deepagents-code-thread-auto-approval.sh",
    ].flatMap((tuiCheck) => [
      [
        "caller timeout",
        tuiCheck,
        {
          ...shellResult(0, ""),
          exitCode: null,
          signal: "SIGTERM" as const,
          timedOut: true,
        },
      ] as const,
      [
        "nonzero TUI result",
        tuiCheck,
        shellResult(1, "TUI cleanup did not reach baseline"),
      ] as const,
    ]),
  )(
    "cleans up the identified DCode TUI session after a %s in %s (#11847, #13838)",
    async (_case, tuiCheck, tuiResult) => {
      const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-tui-caller-timeout-"));
      const cleanup = new CleanupRegistry();
      const responses: ShellProbeResult[] = [
        shellResult(0, ""),
        shellResult(0, "NEMOCLAW_DCODE_PROCESS_COUNT:2\n"),
        tuiResult,
        shellResult(0, "NEMOCLAW_DCODE_PROCESS_COUNT:2\nNEMOCLAW_TUI_CALLER_RECOVERY_OK:2\n"),
      ];
      let responseIndex = 0;
      const run = vi.fn(
        async (_command: TrustedShellCommand, _options?: ShellProbeRunOptions) =>
          responses[responseIndex++]!,
      );

      try {
        await expect(
          runE2eCloudExperimentalChecks(
            "cloud-langchain-deepagents-code",
            "deepagents-sandbox",
            [tuiCheck],
            {
              artifacts: new ArtifactSink(artifactRoot),
              cleanup,
              host: new HostCliClient({ run }),
              secrets: new SecretStore({}, (note) => {
                throw new Error(note);
              }),
            },
          ),
        ).rejects.toThrow();

        expect(run).toHaveBeenCalledTimes(4);
        const tuiCommand = run.mock.calls[2]?.[0];
        const tuiOptions = run.mock.calls[2]?.[1];
        const sessionId = tuiOptions?.env?.NEMOCLAW_TUI_SESSION_ID;
        expect(tuiCommand).toMatchObject({
          command: "bash",
          args: [path.join(process.cwd(), tuiCheck)],
        });
        expect(sessionId).toMatch(/^[0-9a-f-]{36}$/u);

        const recoveryCommand = run.mock.calls[3]?.[0];
        expect(recoveryCommand).toMatchObject({
          command: "bash",
          args: expect.arrayContaining(["recover", "deepagents-sandbox", sessionId, "2"]),
        });
        expect(recoveryCommand?.args.includes("restore-startup-config")).toBe(
          tuiCheck.endsWith("12-deepagents-code-thread-auto-approval.sh"),
        );

        await expect(cleanup.runAll()).resolves.toEqual({
          passed: [expect.stringContaining("clean up failed DCode TUI session")],
          failures: [],
        });
        expect(run).toHaveBeenCalledTimes(4);
      } finally {
        fs.rmSync(artifactRoot, { force: true, recursive: true });
      }
    },
  );

  it("reports failed startup config restoration after a DCode TUI timeout (#13838)", async () => {
    const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-tui-restore-failure-"));
    const responses: ShellProbeResult[] = [
      shellResult(0, ""),
      shellResult(0, "NEMOCLAW_DCODE_PROCESS_COUNT:2\n"),
      { ...shellResult(0, ""), exitCode: null, signal: "SIGTERM", timedOut: true },
      shellResult(1, "mv: permission denied"),
    ];
    let responseIndex = 0;
    const run = vi.fn(
      async (_command: TrustedShellCommand, _options?: ShellProbeRunOptions) =>
        responses[responseIndex++]!,
    );

    try {
      await expect(
        runE2eCloudExperimentalChecks(
          "cloud-langchain-deepagents-code",
          "deepagents-sandbox",
          ["test/e2e/e2e-cloud-experimental/checks/12-deepagents-code-thread-auto-approval.sh"],
          {
            artifacts: new ArtifactSink(artifactRoot),
            cleanup: new CleanupRegistry(),
            host: new HostCliClient({ run }),
            secrets: new SecretStore({}, (note) => {
              throw new Error(note);
            }),
          },
        ),
      ).rejects.toThrow("clean up the failed DCode TUI session failed: mv: permission denied");
      expect(run.mock.calls[3]?.[0]).toMatchObject({
        args: expect.arrayContaining(["restore-startup-config"]),
      });
    } finally {
      fs.rmSync(artifactRoot, { force: true, recursive: true });
    }
  });
});

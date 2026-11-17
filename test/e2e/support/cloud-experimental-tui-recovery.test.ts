// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
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
        shellResult(0, "NEMOCLAW_DCODE_EXPORT_BASELINE_OK\n"),
      ];
      let responseIndex = 0;
      const run = vi.fn(
        async (_command: TrustedShellCommand, _options?: ShellProbeRunOptions) =>
          responses[responseIndex++]!,
      );

      const expectedCalls = tuiCheck.endsWith("12-deepagents-code-thread-auto-approval.sh") ? 5 : 4;
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

        expect(run).toHaveBeenCalledTimes(expectedCalls);
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

        expect(run.mock.calls[4]?.[0]).toEqual(
          expectedCalls === 5
            ? expect.objectContaining({
                command: "bash",
                args: [path.join(process.cwd(), tuiCheck), "--verify-export-baseline"],
              })
            : undefined,
        );
        expect(run.mock.calls[4]?.[1]?.env?.SANDBOX_NAME).toBe(
          expectedCalls === 5 ? "deepagents-sandbox" : undefined,
        );

        await expect(cleanup.runAll()).resolves.toEqual({
          passed: [expect.stringContaining("clean up failed DCode TUI session")],
          failures: [],
        });
        expect(run).toHaveBeenCalledTimes(expectedCalls);
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
  it("keeps recovery armed when the disabled export baseline cannot be confirmed", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-recovery-baseline-"));
    const cleanup = new CleanupRegistry();
    const recovered = shellResult(
      0,
      "NEMOCLAW_DCODE_PROCESS_COUNT:2\nNEMOCLAW_TUI_CALLER_RECOVERY_OK:2\n",
    );
    const responses = [
      shellResult(0, ""),
      shellResult(0, "NEMOCLAW_DCODE_PROCESS_COUNT:2\n"),
      shellResult(1, "interrupted TUI"),
      recovered,
      shellResult(0, "baseline is still thread-opt-in"),
      recovered,
      shellResult(0, "NEMOCLAW_DCODE_EXPORT_BASELINE_OK\n"),
    ];
    let index = 0;
    const run = vi.fn(async () => responses[index++]!);
    try {
      await expect(
        runE2eCloudExperimentalChecks(
          "cloud-langchain-deepagents-code",
          "deepagents-sandbox",
          ["test/e2e/e2e-cloud-experimental/checks/12-deepagents-code-thread-auto-approval.sh"],
          {
            artifacts: new ArtifactSink(root),
            cleanup,
            host: new HostCliClient({ run }),
            secrets: new SecretStore({}, (note) => {
              throw new Error(note);
            }),
          },
        ),
      ).rejects.toThrow("export baseline recovery is incomplete");
      expect(run).toHaveBeenCalledTimes(5);
      await expect(cleanup.runAll()).resolves.toMatchObject({ failures: [] });
      expect(run).toHaveBeenCalledTimes(7);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([false, true])(
    "executes startup config restoration with move failure %s",
    (moveFails) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-guard-files-"));
      const bin = path.join(root, "bin");
      const sandbox = path.join(root, "sandbox");
      const proc = path.join(root, "proc");
      fs.mkdirSync(bin);
      fs.mkdirSync(proc);
      fs.mkdirSync(path.join(sandbox, ".deepagents"), { recursive: true });
      const config = path.join(sandbox, ".deepagents/config.toml");
      const backup = path.join(sandbox, ".nemoclaw-e2e-startup-config.bak");
      fs.writeFileSync(config, 'mode = "auto"\n');
      fs.writeFileSync(backup, 'mode = "manual"\n');
      fs.writeFileSync(
        path.join(bin, "openshell"),
        [
          `#!${process.execPath}`,
          'const {spawnSync} = require("node:child_process");',
          'const args = process.argv.slice(2).map(arg => arg.replaceAll("/sandbox/", process.env.NEMOCLAW_TEST_SANDBOX + "/"));',
          'const result = spawnSync(args[5], args.slice(6), {env: process.env, stdio: "inherit"});',
          "process.exit(result.status ?? 1);",
        ].join("\n"),
        { mode: 0o755 },
      );
      // The child process observes the requested filesystem error through PATH.
      fs.writeFileSync(
        path.join(bin, "mv"),
        moveFails ? "#!/bin/sh\nexit 7\n" : '#!/bin/sh\nexec /bin/mv "$@"\n',
        { mode: 0o755 },
      );
      try {
        const result = spawnSync(
          "bash",
          [
            path.resolve("test/e2e/e2e-cloud-experimental/dcode-tui-session-guard.sh"),
            "recover",
            "deepagents-sandbox",
            "12345678-1234-1234-1234-123456789abc",
            "0",
            proc,
            "restore-startup-config",
          ],
          {
            encoding: "utf8",
            timeout: 10_000,
            env: {
              ...process.env,
              PATH: `${bin}:${process.env.PATH}`,
              NEMOCLAW_TEST_SANDBOX: sandbox,
            },
          },
        );
        expect(result.status, result.stderr).toBe(moveFails ? 7 : 0);
        expect(fs.readFileSync(config, "utf8")).toBe(
          moveFails ? 'mode = "auto"\n' : 'mode = "manual"\n',
        );
        expect(fs.existsSync(backup)).toBe(moveFails);
        expect(result.stdout.includes("NEMOCLAW_TUI_CALLER_RECOVERY_OK")).toBe(!moveFails);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );
  it.each([
    ["disabled", false, "disabled", "disabled", true],
    ["thread-opt-in", false, "disabled", "disabled", false],
    ["disabled", true, "disabled", "disabled", false],
    ["disabled", false, "thread-opt-in", "disabled", false],
    ["disabled", false, "disabled", "thread-opt-in", false],
  ] as const)(
    "verifies retained mode %s, observability %s, status %s and capability %s",
    (mode, observabilityEnabled, statusMode, capability, passes) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-export-verifier-"));
      const bin = path.join(root, "bin");
      fs.mkdirSync(bin);
      fs.mkdirSync(path.join(root, ".nemoclaw"));
      fs.writeFileSync(
        path.join(root, ".nemoclaw/sandboxes.json"),
        JSON.stringify({
          sandboxes: {
            "deepagents-sandbox": {
              agent: "langchain-deepagents-code",
              dcodeAutoApprovalMode: mode,
              observabilityEnabled,
            },
          },
        }),
      );
      const cli = path.join(bin, "nemoclaw");
      const status = {
        name: "deepagents-sandbox",
        agent: "langchain-deepagents-code",
        dcodeAutoApprovalMode: statusMode,
      };
      fs.writeFileSync(cli, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(status)}'\n`, {
        mode: 0o755,
      });
      fs.writeFileSync(path.join(bin, "openshell"), `#!/bin/sh\nprintf '%s\\n' '${capability}'\n`, {
        mode: 0o755,
      });
      try {
        const result = spawnSync(
          "bash",
          [
            path.resolve(
              "test/e2e/e2e-cloud-experimental/checks/12-deepagents-code-thread-auto-approval.sh",
            ),
            "--verify-export-baseline",
          ],
          {
            encoding: "utf8",
            timeout: 10_000,
            env: {
              ...process.env,
              PATH: `${bin}:${process.env.PATH}`,
              HOME: root,
              SANDBOX_NAME: "deepagents-sandbox",
              NEMOCLAW_CLI_BIN: cli,
            },
          },
        );
        expect(result.status === 0, result.stderr).toBe(passes);
        expect(result.stdout.includes("NEMOCLAW_DCODE_EXPORT_BASELINE_OK")).toBe(passes);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

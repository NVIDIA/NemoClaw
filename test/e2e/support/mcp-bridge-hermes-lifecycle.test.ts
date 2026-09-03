// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { HERMES_SHIELDS_COMMAND_TIMEOUT_MS } from "../../../tools/e2e/hermes-timeout-contract.mts";
import { type CommandRunner, HostCliClient, SandboxClient } from "../fixtures/clients/index.ts";
import type {
  ShellProbeResult,
  ShellProbeRunOptions,
  TrustedShellCommand,
} from "../fixtures/shell-probe.ts";
import {
  assertHermesConfig,
  assertHermesManagedAddSurvivesLockedGatewayRestartAndStateLayout,
  assertHermesReloadRollback,
  lowerHermesShieldsForCleanup,
  reopenHermesMcpMaintenanceWindow,
} from "../live/mcp-bridge-hermes-lifecycle.ts";

interface RunnerCall {
  command: string;
  args: string[];
  options?: ShellProbeRunOptions;
}

function shellResult(exitCode = 0, stdout = "", stderr = ""): ShellProbeResult {
  return {
    command: [],
    exitCode,
    signal: null,
    timedOut: false,
    stdout,
    stderr,
    artifacts: {
      stdout: "/tmp/stdout",
      stderr: "/tmp/stderr",
      result: "/tmp/result",
    },
  };
}

class RecordingRunner implements CommandRunner {
  readonly calls: RunnerCall[] = [];
  private readonly responses: ShellProbeResult[];

  constructor(responses: ShellProbeResult[] = []) {
    this.responses = [...responses];
  }

  async run(
    command: TrustedShellCommand,
    options?: ShellProbeRunOptions,
  ): Promise<ShellProbeResult> {
    this.calls.push({ command: command.command, args: [...command.args], options });
    return this.responses.shift() ?? shellResult();
  }
}

class HermesConfigAssertionRunner implements CommandRunner {
  constructor(private readonly configPath: string) {}

  async run(command: TrustedShellCommand): Promise<ShellProbeResult> {
    const shellScript = command.args.at(-1) ?? "";
    const marker = "/opt/hermes/.venv/bin/python - <<'PY'\n";
    const scriptStart = shellScript.indexOf(marker) + marker.length;
    const scriptEnd = shellScript.lastIndexOf("\nPY");
    expect(scriptStart, "Hermes config assertion Python start").toBeGreaterThanOrEqual(
      marker.length,
    );
    expect(scriptEnd, "Hermes config assertion Python end").toBeGreaterThanOrEqual(scriptStart);
    const pythonScript = shellScript
      .slice(scriptStart, scriptEnd)
      .replace("import pathlib, re, yaml", "import pathlib, re, sys, yaml")
      .replace(
        "path = pathlib.Path('/sandbox/.hermes/config.yaml')",
        "path = pathlib.Path(sys.argv[1])",
      );
    const result = spawnSync("python3", ["-", this.configPath], {
      encoding: "utf8",
      input: pythonScript,
      killSignal: "SIGKILL",
      timeout: 10_000,
    });
    const error = result.error?.message ?? "";
    return shellResult(
      result.status ?? 1,
      result.stdout,
      [result.stderr, error].filter(Boolean).join("\n"),
    );
  }
}

function writeHermesConfig(configPath: string, authorization: string): void {
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      mcp_servers: {
        fake: {
          url: "https://mcp.example.test/mcp",
          headers: { Authorization: authorization },
        },
      },
    }),
  );
}

function sandboxWithInspectionState(state: string): SandboxClient {
  return new SandboxClient({
    run: async () => ({
      command: ["openshell"],
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: `${JSON.stringify({ ok: true, state })}\n`,
      stderr: "",
      artifacts: {
        stdout: "/tmp/stdout",
        stderr: "/tmp/stderr",
        result: "/tmp/result",
      },
    }),
  });
}

describe("Hermes MCP live rollback inspection", () => {
  it("accepts the managed inspection helper's matched result", async () => {
    await expect(
      assertHermesReloadRollback(
        sandboxWithInspectionState("matched"),
        "hermes-e2e",
        "https://mcp.example.test",
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects the internal integrity state's current label", async () => {
    await expect(
      assertHermesReloadRollback(
        sandboxWithInspectionState("current"),
        "hermes-e2e",
        "https://mcp.example.test",
      ),
    ).rejects.toMatchObject({
      actual: { ok: true, state: "current" },
      expected: { ok: true, state: "matched" },
    });
  });
});

describe("Hermes MCP managed configuration assertion", () => {
  it("accepts a revision-scoped credential placeholder through the sandbox boundary (#10155)", async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-config-assertion-"));
    const configPath = path.join(temp, "config.yaml");
    writeHermesConfig(configPath, "Bearer openshell:resolve:env:v12_FAKE_MCP_SECRET");

    try {
      await expect(
        assertHermesConfig(
          new SandboxClient(new HermesConfigAssertionRunner(configPath)),
          "hermes-e2e",
          "https://mcp.example.test/mcp",
        ),
      ).resolves.toBeUndefined();
    } finally {
      fs.rmSync(temp, { force: true, recursive: true });
    }
  });

  it("rejects an unscoped credential placeholder through the sandbox boundary (#10155)", async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-config-assertion-"));
    const configPath = path.join(temp, "config.yaml");
    writeHermesConfig(configPath, "Bearer openshell:resolve:env:FAKE_MCP_SECRET");

    try {
      await expect(
        assertHermesConfig(
          new SandboxClient(new HermesConfigAssertionRunner(configPath)),
          "hermes-e2e",
          "https://mcp.example.test/mcp",
        ),
      ).rejects.toThrow("Hermes MCP config contains placeholder and no raw host secret failed");
    } finally {
      fs.rmSync(temp, { force: true, recursive: true });
    }
  });
});

describe("Hermes MCP managed Shields restoration", () => {
  it("keeps every Shields client alive for the owned provider mutation", async () => {
    const mcpUrl = "https://mcp.example.test/mcp";
    const hostRunner = new RecordingRunner([
      shellResult(),
      shellResult(0, "Shields: UP\n"),
      shellResult(0, "Gateway restarted\nhealth passed\n"),
      shellResult(
        0,
        `${JSON.stringify({
          bridges: [{ server: "fake", url: mcpUrl, adapter: { registered: true } }],
        })}\n`,
      ),
      shellResult(),
    ]);
    const sandboxRunner = new RecordingRunner([
      shellResult(0, "HERMES_MCP_LOCKED_INTEGRITY_CURRENT\n"),
      shellResult(0, `${JSON.stringify({ state: "matched" })}\n`),
    ]);

    await assertHermesManagedAddSurvivesLockedGatewayRestartAndStateLayout(
      new HostCliClient(hostRunner, { cliPath: "nemoclaw" }),
      new SandboxClient(sandboxRunner),
      "hermes-e2e",
      mcpUrl,
    );

    expect(
      hostRunner.calls
        .filter(({ args }) => args[1] === "shields")
        .map(({ options }) => options?.timeoutMs),
    ).toEqual([
      HERMES_SHIELDS_COMMAND_TIMEOUT_MS,
      HERMES_SHIELDS_COMMAND_TIMEOUT_MS,
      HERMES_SHIELDS_COMMAND_TIMEOUT_MS,
    ]);
  });
});

describe("Hermes MCP post-rebuild maintenance", () => {
  it("opens a fresh Shields-down timer before the final config mutation", async () => {
    const runner = new RecordingRunner();
    const host = new HostCliClient(runner, { cliPath: "nemoclaw" });

    await reopenHermesMcpMaintenanceWindow(host, "hermes-e2e");

    expect(runner.calls).toEqual([
      expect.objectContaining({
        command: "nemoclaw",
        args: ["hermes-e2e", "shields", "up"],
        options: expect.objectContaining({
          artifactName: "hermes-mcp-shields-up-before-post-rebuild-remove",
          timeoutMs: HERMES_SHIELDS_COMMAND_TIMEOUT_MS,
        }),
      }),
      expect.objectContaining({
        command: "nemoclaw",
        args: [
          "hermes-e2e",
          "shields",
          "down",
          "--timeout",
          "15m",
          "--reason",
          "Post-rebuild MCP removal E2E",
        ],
        options: expect.objectContaining({
          artifactName: "hermes-mcp-shields-down-before-post-rebuild-remove",
          timeoutMs: HERMES_SHIELDS_COMMAND_TIMEOUT_MS,
        }),
      }),
    ]);
  });

  it("keeps Shields up when posture normalization fails", async () => {
    const runner = new RecordingRunner([shellResult(1)]);
    const host = new HostCliClient(runner, { cliPath: "nemoclaw" });

    await expect(reopenHermesMcpMaintenanceWindow(host, "hermes-e2e")).rejects.toThrow(
      "normalize Hermes shields before post-rebuild MCP removal failed: exit=1",
    );

    expect(runner.calls).toEqual([
      expect.objectContaining({
        command: "nemoclaw",
        args: ["hermes-e2e", "shields", "up"],
      }),
    ]);
  });
});

describe("Hermes MCP cleanup posture", () => {
  it("accepts an already-down Shields posture", async () => {
    const runner = new RecordingRunner([
      shellResult(1, "", "Config is already unlocked for hermes-e2e"),
      shellResult(0, "  Shields: DOWN (temporarily unlocked)\n"),
    ]);
    const host = new HostCliClient(runner, { cliPath: "nemoclaw" });

    await lowerHermesShieldsForCleanup(host, "hermes-e2e");

    expect(runner.calls).toEqual([
      expect.objectContaining({
        command: "nemoclaw",
        args: ["hermes-e2e", "shields", "down", "--timeout", "5m", "--reason", "E2E cleanup"],
      }),
      expect.objectContaining({
        command: "nemoclaw",
        args: ["hermes-e2e", "shields", "status"],
      }),
    ]);
  });

  it("rejects cleanup when Shields remain up", async () => {
    const runner = new RecordingRunner([
      shellResult(1, "", "required executable does not exist"),
      shellResult(0, "  Shields: UP\n"),
    ]);
    const host = new HostCliClient(runner, { cliPath: "nemoclaw" });

    await expect(lowerHermesShieldsForCleanup(host, "hermes-e2e")).rejects.toThrow(
      "Hermes Shields cleanup could not confirm DOWN posture",
    );
  });

  it("rejects unrelated absence output from Shields status", async () => {
    const runner = new RecordingRunner([
      shellResult(1, "", "Config transition failed"),
      shellResult(1, "", "provider configuration not found"),
    ]);
    const host = new HostCliClient(runner, { cliPath: "nemoclaw" });

    await expect(lowerHermesShieldsForCleanup(host, "hermes-e2e")).rejects.toThrow(
      "Hermes Shields cleanup could not confirm DOWN posture",
    );
  });

  it("accepts cleanup after the sandbox is removed", async () => {
    const runner = new RecordingRunner([
      shellResult(1, "", "  Sandbox 'hermes-e2e' does not exist.\n"),
    ]);
    const host = new HostCliClient(runner, { cliPath: "nemoclaw" });

    await lowerHermesShieldsForCleanup(host, "hermes-e2e");

    expect(runner.calls).toHaveLength(1);
  });
});

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { CommandRunner } from "../framework/clients/index.ts";
import { GatewayClient, HostCliClient, ProviderClient, SandboxClient, StateClient } from "../framework/clients/index.ts";
import type { ShellProbeResult, ShellProbeRunOptions } from "../framework/shell-probe.ts";

interface RunnerCall {
  command: string;
  options?: ShellProbeRunOptions;
}

class FakeRunner implements CommandRunner {
  readonly calls: RunnerCall[] = [];
  stdout = "";
  stderr = "";
  exitCode: number | null = 0;

  async run(command: string, options?: ShellProbeRunOptions): Promise<ShellProbeResult> {
    this.calls.push({ command, options });
    return {
      command: [command, ...(options?.args ?? [])],
      exitCode: this.exitCode,
      signal: null,
      timedOut: false,
      stdout: this.stdout,
      stderr: this.stderr,
      artifacts: {
        stdout: "/tmp/stdout.txt",
        stderr: "/tmp/stderr.txt",
        result: "/tmp/result.json",
      },
    };
  }
}

describe("E2E fixture clients", () => {
  it("host client runs the configured NemoClaw CLI", async () => {
    const runner = new FakeRunner();
    runner.stdout = "nemoclaw 0.1.0\n";
    const host = new HostCliClient(runner, { cliPath: "./bin/nemoclaw.js" });

    await host.expectNemoclawAvailable();

    expect(runner.calls).toEqual([
      {
        command: "./bin/nemoclaw.js",
        options: { artifactName: "nemoclaw-version", args: ["--version"] },
      },
    ]);
  });

  it("gateway client delegates through NemoClaw gateway status", async () => {
    const runner = new FakeRunner();
    const host = new HostCliClient(runner, { cliPath: "nemoclaw" });
    const gateway = new GatewayClient(host);

    await gateway.expectHealthy();

    expect(runner.calls[0]).toEqual({
      command: "nemoclaw",
      options: { artifactName: "gateway-status", args: ["gateway", "status"] },
    });
  });

  it("sandbox client builds OpenShell sandbox commands", async () => {
    const runner = new FakeRunner();
    const sandbox = new SandboxClient(runner, { openshellPath: "openshell" });

    await sandbox.exec("assistant", ["echo", "ok"]);

    expect(runner.calls[0]).toEqual({
      command: "openshell",
      options: {
        artifactName: "sandbox-exec-assistant",
        args: ["sandbox", "exec", "assistant", "--", "echo", "ok"],
      },
    });
  });

  it("provider client parses JSON from curl output", async () => {
    const runner = new FakeRunner();
    runner.stdout = JSON.stringify({ ok: true });
    const provider = new ProviderClient(runner);

    await expect(provider.getJson("http://127.0.0.1:8080/health")).resolves.toEqual({ ok: true });
    expect(runner.calls[0]).toEqual({
      command: "curl",
      options: {
        artifactName: "curl-http://127.0.0.1:8080/health",
        args: ["-fsSL", "http://127.0.0.1:8080/health"],
      },
    });
  });

  it("state client reads text and JSON files", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-e2e-state-"));
    try {
      const file = path.join(tmp, "state.json");
      fs.writeFileSync(file, JSON.stringify({ sandbox: "assistant" }), "utf8");
      const state = new StateClient();

      await expect(state.exists(file)).resolves.toBe(true);
      await expect(state.readJson(file)).resolves.toEqual({ sandbox: "assistant" });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

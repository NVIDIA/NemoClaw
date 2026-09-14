// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, onTestFinished, vi } from "vitest";

import { ArtifactSink } from "../fixtures/artifacts.ts";
import { SandboxClient } from "../fixtures/clients/sandbox.ts";
import { startTestProgress } from "../fixtures/progress.ts";
import {
  acpMessageContainsPong,
  classifyHermesAcpFailureDiagnostic,
  createHermesAcpPromptEvidenceTracker,
  hermesAcpExchangeEvidencePassed,
  hermesAcpGatewayStoppedPreconditionPassed,
  hermesAcpLiveHostEnv,
  hermesAcpScenarioTimeoutMs,
  isAcpResponse,
  isProcessAbsent,
  runHermesAcpLiveScenario,
} from "../fixtures/hermes-acp-live.ts";

describe("Hermes ACP live evidence boundary", () => {
  const shellResult = ({
    exitCode,
    signal = null,
    stderr = "",
    stdout = "",
    timedOut = false,
  }: {
    exitCode: number;
    signal?: NodeJS.Signals | null;
    stderr?: string;
    stdout?: string;
    timedOut?: boolean;
  }) => ({
    command: ["openshell", "status"],
    exitCode,
    signal,
    timedOut,
    stdout,
    stderr,
    artifacts: { stdout: "", stderr: "", result: "" },
  });

  it("recognizes the OpenShell 0.0.116 stopped-gateway response (#10947)", () => {
    expect(
      hermesAcpGatewayStoppedPreconditionPassed(
        shellResult({
          exitCode: 1,
          stderr:
            "Error:   × client error (Connect)\n  ├─▶ tcp connect error\n  ╰─▶ Connection refused (os error 111)\n",
        }),
      ),
    ).toBe(true);
    expect(
      hermesAcpGatewayStoppedPreconditionPassed(
        shellResult({ exitCode: 0, stdout: "Status: Disconnected\nGateway: nemoclaw\n" }),
      ),
    ).toBe(true);
    expect(
      hermesAcpGatewayStoppedPreconditionPassed(
        shellResult({
          exitCode: 0,
          stdout: "Status: Disconnected\nGateway: nemoclaw\n",
          timedOut: true,
        }),
      ),
    ).toBe(false);
    expect(
      hermesAcpGatewayStoppedPreconditionPassed(
        shellResult({
          exitCode: 0,
          signal: "SIGTERM",
          stdout: "Status: Disconnected\nGateway: nemoclaw\n",
        }),
      ),
    ).toBe(false);
    expect(
      hermesAcpGatewayStoppedPreconditionPassed(
        shellResult({ exitCode: 1, stderr: "Error: permission denied\n" }),
      ),
    ).toBe(false);
    expect(
      hermesAcpGatewayStoppedPreconditionPassed(
        shellResult({ exitCode: 1, stderr: "Connection refused", timedOut: true }),
      ),
    ).toBe(false);
    expect(
      hermesAcpGatewayStoppedPreconditionPassed(
        shellResult({
          exitCode: 1,
          signal: "SIGTERM",
          stderr:
            "Error:   × client error (Connect)\n  ├─▶ tcp connect error\n  ╰─▶ Connection refused (os error 111)\n",
        }),
      ),
    ).toBe(false);
  });

  it.each(["installed", "checkout"] as const)(
    "initializes through the %s adapter",
    async (installation) => {
      const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-acp-launch-"));
      const adapterEntrypoint = path.join(artifactDir, "nemoclaw-acp");
      fs.writeFileSync(
        adapterEntrypoint,
        `#!${process.execPath}
const readline = require("node:readline");
readline.createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }) + "\\n");
});
`,
        { mode: 0o700 },
      );
      const progress = startTestProgress(
        "ACP adapter launch",
        ["launch adapter", "verify result"],
        {
          logLine: () => undefined,
        },
      );
      onTestFinished(() => {
        progress.stop();
        fs.rmSync(artifactDir, { force: true, recursive: true });
      });
      const sandbox = new SandboxClient({
        run: vi.fn().mockResolvedValue({ exitCode: 1, stdout: "", stderr: "" }),
      });

      await expect(
        runHermesAcpLiveScenario({
          adapterEntrypoint: installation === "checkout" ? adapterEntrypoint : undefined,
          artifacts: new ArtifactSink(artifactDir),
          env: { PATH: installation === "installed" ? artifactDir : "" },
          progress,
          sandbox,
          sandboxName: "e2e-hermes",
          scenario: "initialize",
        }),
      ).resolves.toBe(true);
      expect(
        JSON.parse(fs.readFileSync(path.join(artifactDir, "hermes-acp-initialize.json"), "utf8")),
      ).toMatchObject({
        passed: true,
        failureClass: null,
        initialized: true,
        exitCode: 0,
        adapterProcessAbsent: true,
        remoteProcessAbsent: true,
        timedOut: false,
      });
    },
    2_000,
  );

  it("records a failed scenario when the adapter executable is missing", async () => {
    const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-acp-missing-"));
    const progress = startTestProgress("missing ACP adapter", ["launch adapter", "verify result"], {
      logLine: () => undefined,
    });
    onTestFinished(() => {
      progress.stop();
      fs.rmSync(artifactDir, { force: true, recursive: true });
    });
    const run = vi.fn().mockResolvedValue({ exitCode: 1, stdout: "", stderr: "" });
    const sandbox = new SandboxClient({ run });

    await expect(
      runHermesAcpLiveScenario({
        artifacts: new ArtifactSink(artifactDir),
        env: { PATH: artifactDir },
        progress,
        sandbox,
        sandboxName: "e2e-hermes",
        scenario: "initialize",
      }),
    ).resolves.toBe(false);
    expect(
      JSON.parse(fs.readFileSync(path.join(artifactDir, "hermes-acp-initialize.json"), "utf8")),
    ).toMatchObject({
      passed: false,
      failureClass: "adapter_start_failed",
      initialized: false,
      adapterProcessAbsent: true,
      remoteProcessAbsent: true,
      timedOut: false,
    });
    expect(run).toHaveBeenCalledOnce();
  }, 2_000);

  it("records only a fixed gateway-recovery failure class from adapter diagnostics (#10947)", async () => {
    const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-acp-recovery-failure-"));
    const adapterEntrypoint = path.join(artifactDir, "nemoclaw-acp");
    fs.writeFileSync(
      adapterEntrypoint,
      `#!${process.execPath}
process.stderr.write("OpenShell gateway rec");
setTimeout(() => {
  process.stderr.write("overy failed: Authorization: Bearer fixture-secret\\n");
  process.exit(1);
}, 10);
`,
      { mode: 0o700 },
    );
    const progress = startTestProgress(
      "ACP gateway recovery failure",
      ["launch adapter", "verify result"],
      { logLine: () => undefined },
    );
    onTestFinished(() => {
      progress.stop();
      fs.rmSync(artifactDir, { force: true, recursive: true });
    });
    const sandbox = new SandboxClient({
      run: vi.fn().mockResolvedValue({ exitCode: 1, stdout: "", stderr: "" }),
    });

    await expect(
      runHermesAcpLiveScenario({
        adapterEntrypoint,
        artifacts: new ArtifactSink(artifactDir),
        env: {},
        progress,
        sandbox,
        sandboxName: "e2e-hermes",
        scenario: "gateway-recovery",
      }),
    ).resolves.toBe(false);
    const receiptText = fs.readFileSync(
      path.join(artifactDir, "hermes-acp-gateway-recovery.json"),
      "utf8",
    );
    expect(JSON.parse(receiptText)).toMatchObject({
      failureClass: "gateway_recovery_failed",
      passed: false,
      rawAcpPayloadRetained: false,
      stderrObserved: true,
    });
    expect(receiptText).not.toContain("fixture-secret");
    expect(receiptText).not.toContain("Authorization");
  }, 2_000);

  it("classifies only known adapter failure diagnostics (#10947)", () => {
    expect(
      classifyHermesAcpFailureDiagnostic(
        "The selected OpenShell gateway could not be recovered. token=fixture-secret",
      ),
    ).toBe("gateway_recovery_failed");
    expect(
      classifyHermesAcpFailureDiagnostic(
        "The selected OpenShell gateway is not ready. token=fixture-secret",
      ),
    ).toBe("gateway_not_ready");
    expect(
      classifyHermesAcpFailureDiagnostic(
        "The Hermes ACP transport could not start safely. token=fixture-secret",
      ),
    ).toBe("transport_start_failed");
    expect(classifyHermesAcpFailureDiagnostic("unrecognized fixture-secret diagnostic")).toBeNull();
  });

  it("passes only host runtime settings to the adapter process", () => {
    expect(
      hermesAcpLiveHostEnv({
        HOME: "/tmp/home",
        NEMOCLAW_OPENSHELL_BIN: "/tmp/exact-openshell",
        PATH: "/usr/bin",
        OPENSHELL_GATEWAY: "nemoclaw",
        NVIDIA_INFERENCE_API_KEY: "secret",
        OPENAI_API_KEY: "secret",
        OPENSHELL_TOKEN: "secret",
        SSH_AUTH_SOCK: "/tmp/agent.sock",
      }),
    ).toEqual({
      HOME: "/tmp/home",
      NEMOCLAW_OPENSHELL_BIN: "/tmp/exact-openshell",
      PATH: "/usr/bin",
      OPENSHELL_GATEWAY: "nemoclaw",
    });
  });

  it("recognizes only the requested JSON-RPC response", () => {
    expect(isAcpResponse({ jsonrpc: "2.0", id: 3, result: {} }, 3)).toBe(true);
    expect(isAcpResponse({ jsonrpc: "2.0", id: 4, result: {} }, 3)).toBe(false);
    expect(isAcpResponse(["2.0", 3], 3)).toBe(false);
  });

  it("finds the bounded PONG assertion in nested ACP messages", () => {
    expect(acpMessageContainsPong({ params: { update: [{ text: "PONG" }] } })).toBe(true);
    expect(acpMessageContainsPong({ params: { update: [{ text: "SPONGE" }] } })).toBe(false);
  });

  it("counts PONG only after the prompt and only for the selected session (#10947)", () => {
    const evidence = createHermesAcpPromptEvidenceTracker();
    evidence.observe({ jsonrpc: "2.0", id: 1, result: { note: "PONG" } });
    evidence.markPromptWritten("session-a");
    evidence.observe({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "session-b",
        update: { text: "PONG" },
      },
    });
    evidence.observe({ jsonrpc: "2.0", id: 3, result: { stopReason: "end_turn" } });
    evidence.observe({
      jsonrpc: "2.0",
      method: "session/update",
      params: { update: { text: "PONG" } },
    });

    expect(evidence.pongObserved).toBe(false);
    expect(
      hermesAcpExchangeEvidencePassed({
        sessionCreated: true,
        promptCompleted: true,
        pongObserved: evidence.pongObserved,
      }),
    ).toBe(false);

    evidence.observe({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "session-a",
        update: { text: "PONG" },
      },
    });
    expect(evidence.pongObserved).toBe(true);
    expect(
      hermesAcpExchangeEvidencePassed({
        sessionCreated: true,
        promptCompleted: true,
        pongObserved: evidence.pongObserved,
      }),
    ).toBe(true);
  });

  it.each(["cancel", "initialize"] as const)(
    "does not start the later %s scenario after the shared ACP deadline expires (#10947)",
    async (scenario) => {
      const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-acp-deadline-"));
      try {
        const artifacts = new ArtifactSink(artifactDir);
        const forbidden = new Proxy(
          {},
          {
            get() {
              throw new Error("an expired ACP scenario must not reach process or sandbox helpers");
            },
          },
        );

        expect(hermesAcpScenarioTimeoutMs(1_000_000, 0)).toBe(180_000);
        expect(hermesAcpScenarioTimeoutMs(100_000, 0)).toBe(100_000);
        expect(hermesAcpScenarioTimeoutMs(1_000, 1_001)).toBeNull();
        await expect(
          runHermesAcpLiveScenario({
            artifacts,
            deadlineAtMs: 1_000,
            env: {},
            now: () => 1_001,
            progress: forbidden as never,
            sandbox: forbidden as never,
            sandboxName: "e2e-hermes",
            scenario,
          }),
        ).resolves.toBe(false);
        const receipt = JSON.parse(
          fs.readFileSync(path.join(artifactDir, `hermes-acp-${scenario}.json`), "utf8"),
        ) as Record<string, unknown>;
        expect(receipt).toMatchObject({
          deadlineExpired: true,
          failureClass: null,
          passed: false,
          scenario,
          scenarioStarted: false,
        });
      } finally {
        fs.rmSync(artifactDir, { force: true, recursive: true });
      }
    },
  );

  it("classifies the live adapter process state", () => {
    expect(isProcessAbsent(undefined)).toBe(true);
    expect(isProcessAbsent(process.pid)).toBe(false);
  });
});

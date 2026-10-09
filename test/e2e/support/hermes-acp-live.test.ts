// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, onTestFinished, vi } from "vitest";

import { resolveNemoClawGatewayRuntime } from "../../../src/lib/onboard/runtime-provider/configured-runtime.ts";

import { ArtifactSink } from "../fixtures/artifacts.ts";
import { SandboxClient } from "../fixtures/clients/sandbox.ts";
import { startTestProgress } from "../fixtures/progress.ts";
import {
  acpMessageContainsPong,
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

  it.each([
    ["installed", "initialize", 0, {}],
    ["checkout", "client-disconnect", 1, {}],
    ["checkout", "exchange", 0, { stderrObserved: true }],
  ] as const)(
    "%s adapter initializes and completes %s",
    async (installation, scenario, exitCode, scenarioEvidence) => {
      const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-acp-launch-"));
      const adapterEntrypoint = path.join(artifactDir, "nemoclaw-acp");
      const environmentReceipt = path.join(artifactDir, "child-env.json");
      const runtimeEnv: NodeJS.ProcessEnv = {
        NEMOCLAW_GATEWAY_RUNTIME: "podman",
        OPENSHELL_PODMAN_SOCKET: "/run/user/1000/podman/podman.sock",
        CONTAINERS_CONF: "/tmp/containers.conf",
        CONTAINERS_STORAGE_CONF: "/tmp/storage.conf",
        XDG_RUNTIME_DIR: "/run/user/1000",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      };
      fs.writeFileSync(
        adapterEntrypoint,
        `#!${process.execPath}
const readline = require("node:readline");
require("node:fs").writeFileSync(${JSON.stringify(environmentReceipt)}, JSON.stringify(process.env));
process.stdout.on("error", () => {
  process.exitCode = 1;
  process.stdin.destroy();
});
readline.createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  if (request.method === "session/new") process.stderr.write("later agent stderr\\n");
  if (request.method === "session/prompt") process.stdout.write(JSON.stringify({
    jsonrpc: "2.0", method: "session/update", params: { sessionId: "session-a", update: { text: "PONG" } }
  }) + "\\n");
  const result = request.method === "session/new" ? { sessionId: "session-a" } : {};
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
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
          env: {
            ...runtimeEnv,
            PATH: installation === "installed" ? artifactDir : "",
            NVIDIA_INFERENCE_API_KEY: "provider-secret",
            OPENSHELL_TOKEN: "openshell-secret",
            SSH_AUTH_SOCK: "/tmp/private-agent.sock",
          },
          progress,
          sandbox,
          sandboxName: "e2e-hermes",
          scenario,
        }),
      ).resolves.toBe(true);
      const childEnv = JSON.parse(fs.readFileSync(environmentReceipt, "utf8"));
      expect(childEnv).toMatchObject(runtimeEnv);
      expect(resolveNemoClawGatewayRuntime(childEnv)).toBe("podman");
      expect(childEnv).not.toHaveProperty("NVIDIA_INFERENCE_API_KEY");
      expect(childEnv).not.toHaveProperty("OPENSHELL_TOKEN");
      expect(childEnv).not.toHaveProperty("SSH_AUTH_SOCK");
      expect(
        JSON.parse(fs.readFileSync(path.join(artifactDir, `hermes-acp-${scenario}.json`), "utf8")),
      ).toMatchObject({
        ...scenarioEvidence,
        passed: true,
        initialized: true,
        exitCode,
        adapterProcessAbsent: true,
        remoteProcessAbsent: true,
        timedOut: false,
      });
      expect(
        fs.readFileSync(path.join(artifactDir, `hermes-acp-${scenario}.stderr.txt`), "utf8"),
      ).not.toContain("later agent stderr");
    },
    2_000,
  );

  it("cleans up a failed restart before propagating its error when remote verification fails", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-acp-restart-failure-"));
    const adapterEntrypoint = path.join(root, "adapter.cjs");
    const pidReceipt = path.join(root, "pid.txt");
    fs.writeFileSync(
      adapterEntrypoint,
      `
process.on("SIGTERM", () => {});
require("node:fs").writeFileSync(${JSON.stringify(pidReceipt)}, String(process.pid));
require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(line).id, result: {} }) + "\\n");
});
`,
    );
    const progress = startTestProgress(
      "failed ACP restart",
      ["restart gateway", "verify adapter absence"],
      {
        logLine: () => undefined,
      },
    );
    onTestFinished(() => {
      progress.stop();
      try {
        const childPid = Number(fs.readFileSync(pidReceipt, "utf8"));
        expect(Number.isSafeInteger(childPid) && childPid > 1).toBe(true);
        process.kill(-childPid, "SIGKILL");
      } catch {
        // The scenario normally removes this test-owned process group first.
      }
      fs.rmSync(root, { force: true, recursive: true });
    });
    const restartError = new Error("gateway restart rejected");
    await expect(
      runHermesAcpLiveScenario({
        adapterEntrypoint,
        artifacts: new ArtifactSink(root),
        env: {},
        progress,
        restartGateway: async () => {
          throw restartError;
        },
        sandbox: new SandboxClient({
          run: vi.fn().mockRejectedValue(new Error("cleanup observation unavailable")),
        }),
        sandboxName: "e2e-hermes",
        scenario: "gateway-restart",
      }),
    ).rejects.toBe(restartError);
    expect(isProcessAbsent(Number(fs.readFileSync(pidReceipt, "utf8")))).toBe(true);
    expect(
      JSON.parse(fs.readFileSync(path.join(root, "hermes-acp-gateway-restart.json"), "utf8")),
    ).toMatchObject({
      passed: false,
      initialized: true,
      adapterProcessAbsent: true,
      remoteProcessAbsent: false,
      timedOut: false,
    });
  }, 5_000);

  it("retains redacted child stderr without persisting ACP stdout", async () => {
    const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-acp-diagnostics-"));
    const adapterEntrypoint = path.join(artifactDir, "adapter.cjs");
    fs.writeFileSync(
      adapterEntrypoint,
      `
process.stdin.resume();
process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 99, result: "private ACP payload" }) + "\\n");
process.stderr.write("gateway recovery failed: explicit-");
setTimeout(() => {
  process.stderr.write("secret Authorization: Bearer bearer-secret\\nhttps://host.invalid/?token=query-secret\\n");
  process.stderr.write("x".repeat(5000) + "oversized-secret\\n");
  process.stderr.write("incomplete-secret");
  process.exitCode = 1;
  process.stdin.destroy();
}, 20);
`,
    );
    const progress = startTestProgress(
      "ACP diagnostics",
      ["launch adapter", "verify diagnostics"],
      {
        logLine: () => undefined,
      },
    );
    onTestFinished(() => {
      progress.stop();
      fs.rmSync(artifactDir, { force: true, recursive: true });
    });
    await expect(
      runHermesAcpLiveScenario({
        adapterEntrypoint,
        artifacts: new ArtifactSink(artifactDir, ["explicit-secret"]),
        env: {},
        progress,
        sandbox: new SandboxClient({
          run: vi.fn().mockResolvedValue({ exitCode: 1, stdout: "", stderr: "" }),
        }),
        sandboxName: "e2e-hermes",
        scenario: "initialize",
      }),
    ).resolves.toBe(false);
    const diagnostics = fs.readFileSync(
      path.join(artifactDir, "hermes-acp-initialize.stderr.txt"),
      "utf8",
    );
    expect(diagnostics).toContain("gateway recovery failed:");
    expect(diagnostics).toContain("diagnostics discarded");
    expect(diagnostics).not.toMatch(
      /explicit-secret|bearer-secret|query-secret|oversized-secret|incomplete-secret|private ACP payload/u,
    );
    expect(
      JSON.parse(fs.readFileSync(path.join(artifactDir, "hermes-acp-initialize.json"), "utf8")),
    ).toMatchObject({
      passed: false,
      stderrObserved: true,
      rawAcpPayloadRetained: false,
      adapterProcessAbsent: true,
      remoteProcessAbsent: true,
    });
  });

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
      initialized: false,
      adapterProcessAbsent: true,
      remoteProcessAbsent: true,
      timedOut: false,
    });
    expect(run).toHaveBeenCalledOnce();
  }, 2_000);

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

  it("preserves the selected Podman runtime and rootless service context for ACP recovery", () => {
    const runtimeEnv = {
      NEMOCLAW_GATEWAY_RUNTIME: "podman",
      OPENSHELL_PODMAN_SOCKET: "/run/user/1000/podman/podman.sock",
      CONTAINERS_CONF: "/tmp/podman/containers.conf",
      CONTAINERS_STORAGE_CONF: "/tmp/podman/storage.conf",
      XDG_RUNTIME_DIR: "/run/user/1000",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    };
    const adapterEnv = hermesAcpLiveHostEnv({
      ...runtimeEnv,
      NVIDIA_INFERENCE_API_KEY: "secret",
      OPENAI_API_KEY: "secret",
      OPENSHELL_TOKEN: "secret",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      UNRELATED_HOST_SETTING: "excluded",
    });

    expect(resolveNemoClawGatewayRuntime(adapterEnv)).toBe("podman");
    expect(adapterEnv).toEqual(runtimeEnv);
  });

  it("keeps Docker selection explicit or default without adding Podman settings", () => {
    expect(hermesAcpLiveHostEnv({})).toEqual({});
    expect(resolveNemoClawGatewayRuntime(hermesAcpLiveHostEnv({}))).toBe("docker");
    const adapterEnv = hermesAcpLiveHostEnv({ NEMOCLAW_GATEWAY_RUNTIME: "docker" });
    expect(adapterEnv).toEqual({ NEMOCLAW_GATEWAY_RUNTIME: "docker" });
    expect(resolveNemoClawGatewayRuntime(adapterEnv)).toBe("docker");
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

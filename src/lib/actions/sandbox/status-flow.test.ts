// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import {
  createStatusFlowHarness,
  resetStatusFlowModuleCache,
} from "../../../../test/support/status-flow-test-harness";

describe("showSandboxStatus flow", () => {
  let exitSpy: MockInstance;

  beforeEach(() => {
    process.exitCode = undefined;
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    resetStatusFlowModuleCache();
  });

  it("warns when the live gateway route differs from the sandbox's recorded route (#6315)", async () => {
    const harness = createStatusFlowHarness({
      currentProvider: "nvidia",
      currentModel: "nvidia/nemotron",
      routeDrift: {
        live: { provider: "openai", model: "gpt-5.2" },
        recorded: { provider: "nvidia", model: "nvidia/nemotron" },
        canConnect: true,
      },
    });

    await expect(harness.showSandboxStatus("alpha")).resolves.toBeUndefined();

    const output = harness.logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain(
      "Warning: gateway inference route (openai/gpt-5.2) differs from the recorded route for this sandbox (nvidia/nvidia/nemotron).",
    );
    expect(output).toContain(
      "nemoclaw 'alpha' connect realigns the gateway to nvidia/nvidia/nemotron",
    );
    expect(output).toContain(
      "inference set --provider 'openai' --model 'gpt-5.2' --sandbox 'alpha'",
    );
    expect(output).toContain("Model:    nvidia/nemotron");
    expect(output).toContain("Provider: nvidia");
  });

  it("shell-quotes hostile route values in drift recovery commands (#6315)", async () => {
    const sandboxName = "alpha's box";
    const harness = createStatusFlowHarness({
      currentProvider: "openai; touch /tmp/pwn",
      currentModel: "$(id) model",
      routeDrift: {
        live: { provider: "openai; touch /tmp/pwn", model: "$(id) model" },
        recorded: { provider: "nvidia", model: "nvidia/nemotron" },
        canConnect: true,
      },
      sandboxEntry: { name: sandboxName },
    });

    await expect(harness.showSandboxStatus(sandboxName)).resolves.toBeUndefined();

    const output = harness.logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("nemoclaw 'alpha'\\''s box' connect realigns the gateway");
    expect(output).toContain(
      "nemoclaw inference set --provider 'openai; touch /tmp/pwn' --model '$(id) model' --sandbox 'alpha'\\''s box'",
    );
  });

  it("does not recommend connect when provider-global identity makes it fail (#6315)", async () => {
    const harness = createStatusFlowHarness({
      routeDrift: {
        live: { provider: "compatible-endpoint", model: "live/model" },
        recorded: { provider: "compatible-endpoint", model: "recorded/model" },
        canConnect: false,
      },
    });

    await expect(harness.showSandboxStatus("alpha")).resolves.toBeUndefined();

    const output = harness.logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("cannot be restored with nemoclaw connect");
    expect(output).not.toContain("connect realigns the gateway");
  });

  it("prints no route drift warning when the live route matches the recorded route (#6315)", async () => {
    const harness = createStatusFlowHarness();

    await expect(harness.showSandboxStatus("alpha")).resolves.toBeUndefined();

    const output = harness.logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).not.toContain("differs from the recorded route");
  });

  it.each([
    ["high", "high"],
    [null, "endpoint-default"],
  ] as const)("reports the effective compatible-endpoint reasoning effort (%s) (#7659)", async (stored, expected) => {
    const harness = createStatusFlowHarness({
      currentProvider: "compatible-endpoint",
      sandboxEntry: {
        provider: "compatible-endpoint",
        preferredInferenceApi: "openai-completions",
        compatibleEndpointReasoningEffort: stored,
      },
    });

    await expect(harness.showSandboxStatus("alpha")).resolves.toBeUndefined();

    const output = harness.logSpy.mock.calls.flat().join("\n");
    expect(output).toContain(`Reasoning effort: ${expected}`);
  });

  it("prints the live sandbox, inference, runtime, session, version, and recovery signals", async () => {
    const harness = createStatusFlowHarness();

    await expect(harness.showSandboxStatus("alpha")).resolves.toBeUndefined();

    const output = harness.logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("Sandbox-scoped status for 'alpha'");
    expect(output).toContain("Sandbox: alpha");
    expect(output).toContain("Model:    nvidia/nemotron");
    expect(output).toContain("Inference: reachable");
    expect(output).toContain("Inference (ollama backend):");
    expect(output).toContain("Serving process (openclaw gateway):");
    expect(output).toContain("not checked");
    expect(output).toContain("Host GPU: yes");
    expect(output).toContain("last CUDA proof failed: cuInit");
    expect(output).toContain("CUDA initialization failed");
    expect(output).toContain("SSH sessions: 2");
    expect(output).toContain("Permissions: mutable default");
    expect(output).toContain("Update:");
    expect(output).toContain("Recovered NemoClaw gateway runtime via gateway reattach.");
    expect(output).toContain("Recovered sandbox 'alpha' from Docker via docker unpause");
    expect(output).toContain("OpenClaw: ");
    expect(output).toContain("not running");
    expect(output).toContain("Docker health:");
    expect(output).toContain("unhealthy");
    expect(output).toContain("NIM:      running (alpha-nim)");
    expect(harness.getActiveSandboxSessionsSpy).toHaveBeenCalledWith("alpha", expect.any(Object));
    expect(harness.getSandboxDockerRuntimeSpy).toHaveBeenCalledWith("alpha");
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("reports zero SSH sessions as 'none' without connection-negative language (#7805)", async () => {
    const harness = createStatusFlowHarness();
    harness.getActiveSandboxSessionsSpy.mockReturnValue({ detected: true, sessions: [] });

    await expect(harness.showSandboxStatus("alpha")).resolves.toBeUndefined();

    const output = harness.logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("SSH sessions: none");
    expect(output).not.toMatch(/^\s*Connected:/m);
  });

  it("reports durable read-only host directory exposure", async () => {
    const source = fs.mkdtempSync(path.join(process.cwd(), ".status-text-host-mount-test-"));
    try {
      const harness = createStatusFlowHarness({
        sandboxEntry: {
          hostMounts: [{ source, target: "/sandbox/project", readOnly: true }],
        },
      });

      await expect(harness.showSandboxStatus("alpha")).resolves.toBeUndefined();

      const output = harness.logSpy.mock.calls.flat().join("\n");
      expect(output).toContain("Host mounts:");
      expect(output).toContain(`${source} -> /sandbox/project (read-only)`);
    } finally {
      fs.rmSync(source, { recursive: true, force: true });
    }
  });

  it("rejects control-character host mounts before terminal rendering", async () => {
    const harness = createStatusFlowHarness({
      sandboxEntry: {
        hostMounts: [
          {
            source: "/srv/project\u001b[31m",
            target: "/sandbox/project",
            readOnly: true,
          },
        ],
      },
    });

    await expect(harness.showSandboxStatus("alpha")).rejects.toThrow(
      "unsafe terminal control characters",
    );
    expect(harness.logSpy.mock.calls.flat().join("\n")).not.toContain("\u001b[31m");
  });

  it("omits SSH sessions when the active-session probe is unavailable (#7805)", async () => {
    const harness = createStatusFlowHarness();
    harness.getActiveSandboxSessionsSpy.mockReturnValue({ detected: false, sessions: [] });

    await expect(harness.showSandboxStatus("alpha")).resolves.toBeUndefined();

    const output = harness.logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).not.toMatch(/^\s*(?:Connected|SSH sessions):/m);
  });

  it("reports active baseline exclusions and their support impact (#7178)", async () => {
    const harness = createStatusFlowHarness({
      sandboxEntry: {
        baselineExclusions: [
          { version: 1, agent: "openclaw", key: "nous_research", digest: "digest" },
        ],
      },
    });

    await expect(harness.showSandboxStatus("alpha")).resolves.toBeUndefined();

    const output = harness.logSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Baseline exclusions: nous_research");
    expect(output).toContain("Support impact:");
    expect(output).toContain("unsupported");
    expect(output).toContain("policy restore <key>");
  });

  it("warns when a recorded exclusion is still present in the live policy (#7178)", async () => {
    const harness = createStatusFlowHarness({
      baselineExclusionStatus: "live-policy-mismatch",
      sandboxEntry: {
        baselineExclusions: [{ version: 1, agent: "openclaw", key: "pypi", digest: "digest" }],
      },
    });

    await expect(harness.showSandboxStatus("alpha")).resolves.toBeUndefined();

    const output = harness.logSpy.mock.calls.flat().join("\n");
    expect(output).toContain("pypi: excluded key is present in live policy");
  });

  it("reports interrupted baseline policy repair and the exact reconciliation command (#7178)", async () => {
    const harness = createStatusFlowHarness({
      sandboxEntry: {
        baselineExclusionTransition: {
          id: "tx-1",
          operation: "restore",
          exclusion: {
            version: 1,
            agent: "openclaw",
            key: "nous_research",
            digest: "digest",
          },
          targetLiveDigest: "current-digest",
          startedAt: "2026-07-19T00:00:00.000Z",
        },
      },
    });

    await expect(harness.showSandboxStatus("alpha")).resolves.toBeUndefined();

    const output = harness.logSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Baseline policy repair required: interrupted restore");
    expect(output).toContain("rebuild blocked");
    expect(output).toContain("nemoclaw alpha policy restore nous_research");
  });

  it("omits serving-process status when the gateway is unavailable (#7003)", async () => {
    const harness = createStatusFlowHarness({
      lookupState: "missing",
      servingProcessHealth: null,
    });

    await expect(harness.showSandboxStatus("alpha")).rejects.toThrow("process.exit(1)");

    const output = harness.logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).not.toContain("Serving process");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it.each([
    { label: "unreachable" as const, detail: "inference.local is unreachable" },
    { label: "unhealthy" as const, detail: "inference.local returned HTTP 503" },
  ])("reports an $label inference.local route and exits nonzero (#6192)", async (testCase) => {
    const harness = createStatusFlowHarness({
      inferenceHealth: {
        ok: false,
        probed: true,
        providerLabel: "Inference route",
        endpoint: "https://inference.local/v1/models",
        detail: testCase.detail,
        failureLabel: testCase.label,
        subprobes: [
          {
            ok: true,
            probed: true,
            providerLabel: "NVIDIA Endpoints",
            endpoint: "https://integrate.api.nvidia.com/v1/models",
            detail: "upstream reachable",
            probeLabel: "upstream",
          },
        ],
      },
    });

    await expect(harness.showSandboxStatus("alpha")).resolves.toBeUndefined();

    const output = harness.logSpy.mock.calls.flat().join("\n");
    expect(output).not.toContain("Inference: healthy");
    expect(output).toContain("Inference: ");
    expect(output).toContain(testCase.label);
    expect(output).toContain("Inference (upstream):");
    expect(process.exitCode).toBe(1);
  });

  it("reports an unavailable inference.local probe and exits nonzero (#6192)", async () => {
    const harness = createStatusFlowHarness({
      inferenceHealth: {
        ok: false,
        probed: false,
        providerLabel: "Inference route",
        endpoint: "https://inference.local/v1/models",
        detail: "Could not probe the route from inside the sandbox.",
      },
    });

    await expect(harness.showSandboxStatus("alpha")).resolves.toBeUndefined();

    const output = harness.logSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Inference: ");
    expect(output).toContain("not probed");
    expect(process.exitCode).toBe(1);
  });

  it("keeps a failed upstream diagnostic non-authoritative in text status (#6192)", async () => {
    const harness = createStatusFlowHarness({
      inferenceHealth: {
        ok: true,
        probed: true,
        providerLabel: "Inference route",
        endpoint: "https://inference.local/v1/models",
        detail: "route reachable",
        subprobes: [
          {
            ok: false,
            probed: true,
            providerLabel: "NVIDIA Endpoints",
            endpoint: "https://integrate.api.nvidia.com/v1/models",
            detail: "host-side upstream probe failed",
            failureLabel: "unreachable",
            probeLabel: "upstream",
          },
        ],
      },
    });

    await expect(harness.showSandboxStatus("alpha")).resolves.toBeUndefined();

    const output = harness.logSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Inference: healthy");
    expect(output).toContain("Inference (upstream):");
    expect(output).toContain("unreachable");
    expect(process.exitCode).toBeUndefined();
  });

  it("distinguishes route reachability from model-invocation health in the rendered labels (#6846)", async () => {
    const harness = createStatusFlowHarness({
      inferenceHealth: {
        ok: true,
        probed: true,
        providerLabel: "Inference route",
        endpoint: "https://inference.local/v1/models",
        detail: "route reachable",
        okLabel: "reachable",
        subprobes: [
          {
            ok: true,
            probed: true,
            providerLabel: "NVIDIA Endpoints",
            endpoint: "https://integrate.api.nvidia.com/v1/chat/completions",
            detail: "model invocation probe succeeded",
            probeLabel: "upstream",
          },
        ],
      },
    });

    await expect(harness.showSandboxStatus("alpha")).resolves.toBeUndefined();

    const output = harness.logSpy.mock.calls.flat().join("\n");
    // The route probe only proves network-path reachability (#6192); the
    // upstream subprobe is what proves the configured model is invocable
    // (#6846). Rendering the same word for both would re-introduce the
    // false-positive this PR fixes.
    expect(output).toContain("Inference: reachable");
    expect(output).not.toContain("Inference: healthy");
    expect(output).toContain("Inference (upstream): healthy");
    expect(process.exitCode).toBeUndefined();
  });

  it("probes terminal runtime agent version when cached metadata is missing", async () => {
    const harness = createStatusFlowHarness({
      sandboxEntry: {
        agent: "langchain-deepagents-code",
        agentVersion: null,
        dcodeAutoApprovalMode: "thread-opt-in",
      },
    });

    await expect(harness.showSandboxStatus("alpha")).resolves.toBeUndefined();

    const output = harness.logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("Harness:  LangChain Deep Agents Code (terminal)");
    expect(output).toContain("DCode auto-approval capability: thread-opt-in");
    expect(output).toContain("Agent:    LangChain Deep Agents Code v0.1.0");
    expect(output).toContain("Update:");
    expect(output).toContain("Run `nemoclaw alpha rebuild` to upgrade");
    expect(harness.checkAgentVersionSpy).toHaveBeenCalledWith("alpha", {
      forceProbe: true,
      skipProbe: false,
    });
  });

  it("preserves the registry entry and exits when the live gateway is missing the sandbox", async () => {
    const harness = createStatusFlowHarness({ lookupState: "missing" });

    await expect(harness.showSandboxStatus("alpha")).rejects.toThrow("process.exit(1)");

    const output = harness.logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain(
      "registered locally, but is not present in the live OpenShell gateway",
    );
    expect(output).toContain("gateway was just recovered via gateway reattach");
    expect(output).toContain("No local registry entry was removed by this status check");
    expect(output).toContain("nemoclaw alpha status");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
    expect(harness.getSandboxDockerRuntimeSpy).not.toHaveBeenCalled();
  });

  it("prints switch guidance without removing registry state for a wrong active gateway (#2276)", async () => {
    const harness = createStatusFlowHarness({
      inferenceHealth: null,
      lookup: {
        state: "wrong_gateway_active",
        activeGateway: "openshell",
        output: "Gateway: openshell\nStatus: Connected",
      },
    });

    await expect(harness.showSandboxStatus("alpha")).rejects.toThrow("process.exit(1)");

    const output = harness.logSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Your sandbox has NOT been removed");
    expect(output).toContain("openshell gateway select nemoclaw");
    expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
  });

  it("renders a local Ollama outage with the backend endpoint and recovery hint", async () => {
    const harness = createStatusFlowHarness({
      currentModel: "llama3.2:1b",
      currentProvider: "ollama-local",
      inferenceHealth: {
        ok: false,
        probed: true,
        providerLabel: "Ollama",
        endpoint: "http://127.0.0.1:11434/api/tags",
        detail: "Start Ollama and retry",
        probeLabel: "ollama backend",
        failureLabel: "unreachable",
      },
      sandboxEntry: {
        model: "llama3.2:1b",
        provider: "ollama-local",
      },
    });

    await expect(harness.showSandboxStatus("alpha")).resolves.toBeUndefined();

    const output = harness.logSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Inference (ollama backend):");
    expect(output).toContain("unreachable");
    expect(output).toContain("Start Ollama and retry");
    expect(output).toContain("http://127.0.0.1:11434/api/tags");
  });

  it("renders fresh shields posture as not configured rather than down", async () => {
    const harness = createStatusFlowHarness({
      shieldsPosture: {
        mode: "mutable_default",
        detail: "not configured (default mutable state)",
      },
    });

    await expect(harness.showSandboxStatus("alpha")).resolves.toBeUndefined();

    const output = harness.logSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Permissions: not configured (default mutable state)");
    expect(output).not.toContain("Permissions: shields down");
  });

  it("renders the live agent version instead of stale registry metadata", async () => {
    const harness = createStatusFlowHarness({
      sandboxEntry: { agentVersion: "2026.5.18" },
      versionCheck: {
        sandboxVersion: "2026.3.11",
        expectedVersion: "2026.6.1",
        isStale: true,
        detectionMethod: "runtime",
      },
    });

    await expect(harness.showSandboxStatus("alpha")).resolves.toBeUndefined();

    const output = harness.logSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Agent:    OpenClaw v2026.3.11");
    expect(output).toContain("Update:");
    expect(output).toContain("v2026.6.1 available");
    expect(output).toContain("Run `nemoclaw alpha rebuild` to upgrade");
    expect(output).not.toContain("Agent:    OpenClaw v2026.5.18");
    expect(harness.checkAgentVersionSpy).toHaveBeenCalledWith("alpha", {
      forceProbe: true,
      skipProbe: false,
    });
  });

  it("does not report inference healthy when gateway verification fails", async () => {
    const harness = createStatusFlowHarness({
      inferenceHealth: null,
      lookup: {
        state: "gateway_unreachable_after_restart",
        output: "Gateway: nemoclaw\nclient error (Connect): Connection refused (os error 111)",
      },
      preflight: {
        failure: null,
        failureLayer: "docker_unreachable",
        suppressInferenceProbe: true,
        exitCode: 1,
      },
    });

    await expect(harness.showSandboxStatus("alpha")).rejects.toThrow("process.exit(1)");

    const output = harness.logSpy.mock.calls.flat().join("\n");
    expect(output).not.toContain("Inference: healthy");
    expect(output).toContain("Inference: not verified (gateway/sandbox state not verified)");
    expect(output).toContain("gateway is still refusing connections after restart");
    expect(output).toContain("Retry `openshell gateway start --name nemoclaw`");
    expect(output).toContain("If the gateway never becomes healthy");
    expect(harness.collectSandboxStatusSnapshotSpy).toHaveBeenCalledWith("alpha", {
      preflight: {
        failure: null,
        failureLayer: "docker_unreachable",
        suppressInferenceProbe: true,
        exitCode: 1,
      },
    });
  });

  it("renders the refreshed preflight after Docker recovery", async () => {
    const preflight = {
      failure: {
        layer: "sandbox_container_stopped" as const,
        dockerUnreachable: false,
      },
      failureLayer: "sandbox_container_stopped" as const,
      suppressInferenceProbe: true,
      exitCode: 1 as const,
    };
    const harness = createStatusFlowHarness({
      preflight,
      postRecoveryPreflight: {
        failure: null,
        failureLayer: null,
        suppressInferenceProbe: false,
        exitCode: 0,
      },
    });

    await expect(harness.showSandboxStatus("alpha")).resolves.toBeUndefined();

    const output = harness.logSpy.mock.calls.flat().join("\n");
    expect(output).not.toContain("Failure layer: sandbox_container_stopped");
    expect(process.exitCode).toBeUndefined();
    expect(harness.collectSandboxStatusSnapshotSpy).toHaveBeenCalledWith("alpha", {
      preflight,
    });
  });

  it("does not erase a dashboard-port conflict during Docker recovery", async () => {
    const conflict = {
      failure: {
        layer: "sandbox_dashboard_port_conflict" as const,
        dockerUnreachable: false,
      },
      failureLayer: "sandbox_dashboard_port_conflict" as const,
      suppressInferenceProbe: true,
      exitCode: 1 as const,
    };
    const harness = createStatusFlowHarness({
      preflight: conflict,
      postRecoveryPreflight: conflict,
    });

    await expect(harness.showSandboxStatus("alpha")).resolves.toBeUndefined();

    const output = harness.logSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Failure layer: sandbox_dashboard_port_conflict");
    expect(process.exitCode).toBe(1);
  });

  it("renders an agent delivery recovery failure as actionable and nonzero", async () => {
    const harness = createStatusFlowHarness({
      inferenceHealth: null,
      lookup: {
        state: "sandbox_recovery_failed",
        output:
          "  Sandbox 'alpha' is present, but its agent delivery chain could not be proven " +
          "(forward-recovery: OpenShell forward state unavailable).",
        recoveredSandbox: true,
      },
    });

    await expect(harness.showSandboxStatus("alpha")).rejects.toThrow("process.exit(1)");

    const output = harness.logSpy.mock.calls.flat().join("\n");
    expect(output).toContain("restored from Docker");
    expect(output).toContain("agent delivery chain could not be proven");
    expect(output).toContain("forward-recovery: OpenShell forward state unavailable");
    expect(output).toContain("Retry `nemoclaw alpha recover`");
    expect(output).not.toContain("Could not verify against live gateway");
  });

  it("does not claim Docker restoration when a visible sandbox fails delivery recovery", async () => {
    const harness = createStatusFlowHarness({
      inferenceHealth: null,
      lookup: {
        state: "sandbox_recovery_failed",
        output:
          "  Sandbox 'alpha' is present, but its agent delivery chain could not be proven " +
          "(gateway-recovery: the managed agent gateway could not be restarted).",
      },
    });

    await expect(harness.showSandboxStatus("alpha")).rejects.toThrow("process.exit(1)");

    const output = harness.logSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Sandbox 'alpha' is present");
    expect(output).toContain("agent delivery chain could not be proven");
    expect(output).not.toContain("restored from Docker");
  });

  it("renders missing gateway metadata after restart without claiming recovery", async () => {
    const harness = createStatusFlowHarness({
      inferenceHealth: null,
      lookup: {
        state: "gateway_missing_after_restart",
        output: "Status: No gateway configured.",
      },
      preflight: {
        failure: null,
        failureLayer: "docker_unreachable",
        suppressInferenceProbe: true,
        exitCode: 1,
      },
    });

    await expect(harness.showSandboxStatus("alpha")).rejects.toThrow("process.exit(1)");

    const output = harness.logSpy.mock.calls.flat().join("\n");
    expect(output).toContain("gateway is no longer configured after restart/rebuild");
    expect(output).toContain("Start the gateway again");
    expect(output).not.toContain("Recovered NemoClaw gateway runtime");
  });

  it("renders gateway identity drift as an unsafe reattachment", async () => {
    const harness = createStatusFlowHarness({
      inferenceHealth: null,
      lookup: {
        state: "identity_drift",
        output: "Error: transport error: handshake verification failed",
      },
    });

    await expect(harness.showSandboxStatus("alpha")).rejects.toThrow("process.exit(1)");

    const output = harness.logSpy.mock.calls.flat().join("\n");
    expect(output).toContain("gateway trust material rotated after restart");
    expect(output).toContain("cannot be reattached safely");
    expect(output).not.toContain("Inference: healthy");
  });

  it("keeps a failed foreign-gateway lookup distinct from recovered status", async () => {
    const harness = createStatusFlowHarness({
      inferenceHealth: null,
      lookup: {
        state: "gateway_error",
        output: "Error: transport error: Connection refused",
      },
      preflight: {
        failure: null,
        failureLayer: "docker_unreachable",
        suppressInferenceProbe: true,
        exitCode: 1,
      },
    });

    await expect(harness.showSandboxStatus("alpha")).rejects.toThrow("process.exit(1)");

    const output = harness.logSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Could not verify sandbox 'alpha'");
    expect(output).toContain("verify the active gateway");
    expect(output).not.toContain("Recovered NemoClaw gateway runtime");
  });

  it("points SSH operators to dashboard-url for remote-access instructions when the gateway is running (#8465)", async () => {
    vi.stubEnv("SSH_CONNECTION", "203.0.113.9 51000 198.51.100.2 22");
    const harness = createStatusFlowHarness({ gatewayRunning: true });

    await expect(harness.showSandboxStatus("alpha")).resolves.toBeUndefined();

    const output = harness.logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("OpenClaw: ");
    expect(output).toContain("running");
    expect(output).toContain(
      "Remote access: run `nemoclaw 'alpha' dashboard-url` for SSH port forward instructions.",
    );
  });

  it("shell-quotes the sandbox name in SSH dashboard guidance (#8465)", async () => {
    vi.stubEnv("SSH_CONNECTION", "203.0.113.9 51000 198.51.100.2 22");
    const sandboxName = "alpha's box";
    const harness = createStatusFlowHarness({
      gatewayRunning: true,
      sandboxEntry: { name: sandboxName },
    });

    await expect(harness.showSandboxStatus(sandboxName)).resolves.toBeUndefined();

    const output = harness.logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain(
      "Remote access: run `nemoclaw 'alpha'\\''s box' dashboard-url` for SSH port forward instructions.",
    );
  });

  it.each([
    {
      caseLabel: "a routable dashboard URL",
      chatUiUrl: "https://dashboard.example.test",
      sandboxEntry: {},
    },
    {
      caseLabel: "a prepared remote bind",
      chatUiUrl: "",
      sandboxEntry: { dashboardRemoteBindPrepared: true },
    },
  ])("omits port forward guidance for $caseLabel (#8465)", async ({ chatUiUrl, sandboxEntry }) => {
    vi.stubEnv("SSH_CONNECTION", "203.0.113.9 51000 198.51.100.2 22");
    vi.stubEnv("CHAT_UI_URL", chatUiUrl);
    const harness = createStatusFlowHarness({ gatewayRunning: true, sandboxEntry });

    await expect(harness.showSandboxStatus("alpha")).resolves.toBeUndefined();

    const output = harness.logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("running");
    expect(output).not.toContain("Remote access: run");
  });

  it("omits dashboard guidance over SSH when the gateway is stopped (#8465)", async () => {
    vi.stubEnv("SSH_CONNECTION", "203.0.113.9 51000 198.51.100.2 22");
    const harness = createStatusFlowHarness({ gatewayRunning: false });

    await expect(harness.showSandboxStatus("alpha")).resolves.toBeUndefined();

    const output = harness.logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("not running");
    expect(output).not.toContain("Remote access: run");
  });

  it("omits the remote-access pointer when the session is not over SSH (#8465)", async () => {
    vi.stubEnv("SSH_CONNECTION", "");
    vi.stubEnv("SSH_CLIENT", "");
    vi.stubEnv("SSH_TTY", "");
    const harness = createStatusFlowHarness({ gatewayRunning: true });

    await expect(harness.showSandboxStatus("alpha")).resolves.toBeUndefined();

    const output = harness.logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("running");
    expect(output).not.toContain("Remote access: run");
  });

  it("renders gateway-level handshake failures without removing registry state", async () => {
    const harness = createStatusFlowHarness({
      inferenceHealth: null,
      lookup: {
        state: "gateway_error",
        output: "Error: transport error: handshake verification failed",
      },
      preflight: {
        failure: null,
        failureLayer: "docker_unreachable",
        suppressInferenceProbe: true,
        exitCode: 1,
      },
    });

    await expect(harness.showSandboxStatus("alpha")).rejects.toThrow("process.exit(1)");

    const output = harness.logSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Could not verify sandbox 'alpha'");
    expect(output).toContain("gateway identity drift after restart");
    expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
  });
});

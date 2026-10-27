// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import type { OpenShellSandboxBufferedCommandExecutor } from "../../adapters/openshell/sandbox-command";
import { nativeLocalIdentity } from "../../inference/native-local/contract";
import { loadAgent } from "../../agent/defs";
import type { SandboxEntry } from "../../state/registry";
import {
  LaunchReadinessEvidenceError,
  LaunchReadinessObservationError,
  hasRecordedNativeNvidiaAttachment,
  requireLaunchSemanticHealth,
  requireNativeInferenceHealth,
  type LaunchReadinessHealthDeps,
} from "./launch-readiness/health";
import { probeSandboxInferenceInvocation } from "./inference-invocation-probe";
import { runSandboxInferenceInvocationProbe } from "./inference-route-health";
import {
  NATIVE_LOCAL_CREDENTIAL_HANDLE,
  recordingProbeShell,
} from "../../../../test/helpers/native-local-probe-shell";
import { nativeLocalTestReceipt } from "../../../../test/helpers/inference-set";
import {
  isSandboxGatewayRunningForStatus,
  waitForStartedHermesGatewayProcess,
} from "./process-recovery";

describe("launch-readiness gateway health scope", () => {
  it("requires a valid recorded native NVIDIA attachment for degraded start", () => {
    const entry = {} as SandboxEntry;
    expect(hasRecordedNativeNvidiaAttachment(entry)).toBe(false);
    expect(
      hasRecordedNativeNvidiaAttachment({
        ...entry,
        nativeNvidiaProviderAttachment: { providerId: "invalid" },
      } as SandboxEntry),
    ).toBe(false);
    expect(
      hasRecordedNativeNvidiaAttachment({
        ...entry,
        nativeNvidiaProviderAttachment: {
          schemaVersion: 1,
          profileId: "nemoclaw-nvidia-inference-v1",
          providerName: "nemoclaw-nvidia-prod-v1",
          providerId: "provider-123",
        },
      } as SandboxEntry),
    ).toBe(true);
  });

  it.each([
    ["becomes observable", [null, null, null, null, null, true], true],
    ["remains unavailable", [null, null, null, null, null, null], false],
  ] as const)(
    "bounds a managed Hermes startup observation that %s",
    async (_case, results, expected) => {
      const observations = [...results];
      const probe = vi.fn(async () => observations.shift() ?? null);
      const sleep = vi.fn(async () => {});

      await expect(
        waitForStartedHermesGatewayProcess("alpha", "nemoclaw-19080", { probe, sleep }),
      ).resolves.toBe(expected);

      expect(probe).toHaveBeenCalledTimes(6);
      expect(sleep.mock.calls).toEqual([[2_000], [2_000], [2_000], [2_000], [2_000]]);
    },
  );

  it("pins the semantic gateway probe to the owning OpenShell gateway (#8942)", async () => {
    const runBuffered = vi.fn<OpenShellSandboxBufferedCommandExecutor["runBuffered"]>(async () => ({
      outcome: { kind: "completed", exitCode: 0 },
      stdout: "__NEMOCLAW_SANDBOX_EXEC_STARTED__\nRUNNING\n",
      stderr: "",
    }));

    await expect(
      isSandboxGatewayRunningForStatus("alpha", "nemoclaw-8091", {
        getSessionAgent: () => null,
        getHealthProbeUrl: () => "http://127.0.0.1:18789/health",
        commandExecutor: { runBuffered },
      }),
    ).resolves.toBe(true);

    expect(runBuffered).toHaveBeenCalledTimes(1);
    expect(runBuffered).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxName: "alpha",
        target: { kind: "named", gatewayName: "nemoclaw-8091" },
        command: expect.arrayContaining([
          "sh",
          "-c",
          expect.stringContaining("http://127.0.0.1:18789/health"),
        ]),
      }),
    );
  });

  it("treats HTTP and transport probe failures as unavailable evidence", async () => {
    const runBuffered = vi.fn<OpenShellSandboxBufferedCommandExecutor["runBuffered"]>(async () => ({
      outcome: { kind: "completed", exitCode: 0 },
      stdout: "__NEMOCLAW_SANDBOX_EXEC_STARTED__\nUNAVAILABLE\n",
      stderr: "",
    }));

    await expect(
      isSandboxGatewayRunningForStatus("alpha", "nemoclaw-8091", {
        getSessionAgent: () => null,
        getHealthProbeUrl: () => "http://127.0.0.1:18789/health",
        commandExecutor: { runBuffered },
      }),
    ).resolves.toBeNull();

    expect(runBuffered.mock.calls[0]?.[0].command.at(-1)).toContain("echo UNAVAILABLE");
    expect(runBuffered.mock.calls[0]?.[0].command.at(-1)).not.toContain("echo STOPPED");
  });

  it.each([
    [0, "200", true],
    [0, "401", true],
    [7, "000", false],
    [0, "503", false],
    [28, "000", null],
  ] as const)(
    "observes cold startup from curl result %s:%s within the caller deadline",
    async (code, http, expected) => {
      const runBuffered = vi.fn<OpenShellSandboxBufferedCommandExecutor["runBuffered"]>(
        async (request) => ({
          outcome: { kind: "completed", exitCode: 0 },
          stdout: execFileSync(
            "sh",
            ["-c", `curl() { printf '%s' '${http}'; return ${code}; }; ${request.command.at(-1)}`],
            { encoding: "utf8" },
          ),
          stderr: "",
        }),
      );
      await expect(
        isSandboxGatewayRunningForStatus("alpha", "nemoclaw-19080", {
          getSessionAgent: () => null,
          getHealthProbeUrl: () => "http://127.0.0.1:18789/health",
          commandExecutor: { runBuffered },
          startup: { timeoutMs: 300 },
        }),
      ).resolves.toBe(expected);
      expect(runBuffered).toHaveBeenCalledWith(
        expect.objectContaining({
          sandboxName: "alpha",
          target: { kind: "named", gatewayName: "nemoclaw-19080" },
          timeoutMilliseconds: 300,
        }),
      );
    },
  );

  it("keeps failed startup transport unavailable rather than classifying the agent as stopped", async () => {
    const runBuffered = vi.fn<OpenShellSandboxBufferedCommandExecutor["runBuffered"]>(async () => ({
      outcome: { kind: "failed", error: { kind: "timeout", message: "deadline expired" } },
      stdout: "",
      stderr: "",
    }));
    await expect(
      isSandboxGatewayRunningForStatus("alpha", "nemoclaw", {
        getSessionAgent: () => null,
        getHealthProbeUrl: () => "http://127.0.0.1:18789/health",
        commandExecutor: { runBuffered },
        startup: { timeoutMs: 300 },
      }),
    ).resolves.toBeNull();
  });

  it("observes Hermes through its native gateway instead of the retired lifecycle controller", async () => {
    const runBuffered = vi.fn<OpenShellSandboxBufferedCommandExecutor["runBuffered"]>(async () => ({
      outcome: { kind: "completed", exitCode: 0 },
      stdout: "__NEMOCLAW_SANDBOX_EXEC_STARTED__\nRUNNING\n",
      stderr: "",
    }));
    await expect(
      isSandboxGatewayRunningForStatus("alpha", "nemoclaw-19080", {
        getSessionAgent: () => loadAgent("hermes"),
        getHealthProbeUrl: () => "http://127.0.0.1:18789/health",
        commandExecutor: { runBuffered },
      }),
    ).resolves.toBe(true);

    expect(runBuffered).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxName: "alpha",
        target: { kind: "named", gatewayName: "nemoclaw-19080" },
        command: expect.arrayContaining([
          "sh",
          "-c",
          expect.stringContaining("http://127.0.0.1:18789/health"),
        ]),
      }),
    );
  });

  it("pins Hermes readiness checks to its recorded OpenShell gateway (#10302)", async () => {
    const gatewayHealth = vi.fn(async () => true);
    const forwardsHealthy = vi.fn(() => true);
    const inferenceProbe = vi.fn(async () => ({
      healthy: true,
      broken: false,
      httpStatus: 200,
      detail: "OK 200",
    }));
    const agent = loadAgent("hermes");
    const entry = {
      name: "alpha",
      agent: "hermes",
      provider: "ollama-local",
      model: "nemotron-3-nano:30b",
    } as SandboxEntry;

    await expect(
      requireLaunchSemanticHealth("alpha", "nemoclaw-19080", "hermes", entry, agent, true, {
        gatewayHealth,
        forwardsHealthy,
        inferenceProbe,
      }),
    ).resolves.toBeUndefined();

    expect(gatewayHealth).toHaveBeenCalledWith("alpha", "nemoclaw-19080");
    expect(gatewayHealth).toHaveBeenCalledOnce();
    expect(forwardsHealthy).toHaveBeenCalledWith("alpha", "nemoclaw-19080");
    expect(forwardsHealthy).toHaveBeenCalledOnce();
    expect(inferenceProbe).toHaveBeenCalledWith("alpha", agent, "nemoclaw-19080");
    expect(inferenceProbe).toHaveBeenCalledOnce();
  });
});

const SANDBOX = "alpha";
const GATEWAY = "nemoclaw";
const MODEL = "nvidia/nemotron-3-ultra-550b-a55b";
const dcodeAgent = loadAgent("langchain-deepagents-code");
const OPENROUTER_GATEWAY_AGENTS = ["openclaw", "hermes"] as const;

function dcodeEntry(provider = "openrouter-api"): SandboxEntry {
  return {
    name: SANDBOX,
    agent: "langchain-deepagents-code",
    provider,
    model: MODEL,
    preferredInferenceApi: null,
  } as SandboxEntry;
}

function dcodeHealthDeps(
  invocation: Awaited<
    ReturnType<NonNullable<LaunchReadinessHealthDeps["inferenceInvocationProbe"]>>
  >,
  httpStatus = 404,
): LaunchReadinessHealthDeps {
  return {
    smoke: vi.fn(async () => ({ ok: true }) as const),
    gatewayHealth: vi.fn(async () => true),
    forwardsHealthy: vi.fn(() => true),
    inferenceProbe: vi.fn(async () => ({
      healthy: true,
      broken: false,
      httpStatus,
      detail: `OK ${httpStatus}`,
    })),
    inferenceInvocationProbe: vi.fn(async () => invocation),
  };
}

describe("Deep Agents Code launch readiness", () => {
  it("rejects unconfigured inference before terminal smoke (#11520)", async () => {
    const smoke = vi.fn(async () => ({ ok: true }) as const);

    await expect(
      requireLaunchSemanticHealth(
        SANDBOX,
        GATEWAY,
        "langchain-deepagents-code",
        dcodeEntry(),
        dcodeAgent,
        false,
        { smoke },
      ),
    ).rejects.toBeInstanceOf(LaunchReadinessEvidenceError);

    expect(smoke).not.toHaveBeenCalled();
  });

  it.each([
    ["openrouter-api", 404],
    ["nvidia-prod", 200],
  ])("accepts %s readiness after an inference request succeeds", async (provider, httpStatus) => {
    const currentDeps = dcodeHealthDeps({ ok: true }, httpStatus);

    await expect(
      requireLaunchSemanticHealth(
        SANDBOX,
        GATEWAY,
        "langchain-deepagents-code",
        dcodeEntry(provider),
        dcodeAgent,
        true,
        currentDeps,
      ),
    ).resolves.toBeUndefined();
    expect(currentDeps.inferenceInvocationProbe).toHaveBeenCalledWith({
      sandboxName: SANDBOX,
      gatewayName: GATEWAY,
      agentName: "langchain-deepagents-code",
      provider,
      model: MODEL,
      preferredInferenceApi: null,
    });
  });

  it.each([
    ["openrouter-api", 404],
    ["nvidia-prod", 200],
  ])("rejects %s readiness when the inference request fails", async (provider, httpStatus) => {
    const currentDeps = dcodeHealthDeps(
      {
        ok: false,
        detail: "sandbox inference invocation probe returned HTTP 401",
        httpStatus: 401,
      },
      httpStatus,
    );

    await expect(
      requireLaunchSemanticHealth(
        SANDBOX,
        GATEWAY,
        "langchain-deepagents-code",
        dcodeEntry(provider),
        dcodeAgent,
        true,
        currentDeps,
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<LaunchReadinessObservationError>>({
        category: "health",
        failedCheck: "inference request",
      }),
    );
  });
});

describe("OpenRouter launch readiness", () => {
  it.each(OPENROUTER_GATEWAY_AGENTS)(
    "accepts the %s catalog 404 after the recorded inference request succeeds (#12621)",
    async (agentName) => {
      const agent = loadAgent(agentName);
      const entry = {
        name: SANDBOX,
        agent: agentName,
        provider: "openrouter-api",
        model: MODEL,
        preferredInferenceApi: "openai-completions",
      } as SandboxEntry;
      const currentDeps = dcodeHealthDeps({ ok: true });

      await expect(
        requireLaunchSemanticHealth(SANDBOX, GATEWAY, agentName, entry, agent, true, currentDeps),
      ).resolves.toBeUndefined();
      expect(currentDeps.inferenceInvocationProbe).toHaveBeenCalledWith({
        sandboxName: SANDBOX,
        gatewayName: GATEWAY,
        agentName,
        provider: "openrouter-api",
        model: MODEL,
        preferredInferenceApi: "openai-completions",
      });
    },
  );

  it.each(OPENROUTER_GATEWAY_AGENTS)(
    "rejects the %s catalog 404 when the recorded inference request fails (#12621)",
    async (agentName) => {
      const agent = loadAgent(agentName);
      const entry = {
        name: SANDBOX,
        agent: agentName,
        provider: "openrouter-api",
        model: MODEL,
        preferredInferenceApi: "openai-completions",
      } as SandboxEntry;
      const currentDeps = dcodeHealthDeps({
        ok: false,
        detail: "sandbox inference invocation probe returned HTTP 401",
        httpStatus: 401,
      });

      await expect(
        requireLaunchSemanticHealth(SANDBOX, GATEWAY, agentName, entry, agent, true, currentDeps),
      ).rejects.toEqual(
        expect.objectContaining<Partial<LaunchReadinessObservationError>>({
          category: "health",
          failedCheck: "inference request",
        }),
      );
      expect(currentDeps.inferenceInvocationProbe).toHaveBeenCalledWith({
        sandboxName: SANDBOX,
        gatewayName: GATEWAY,
        agentName,
        provider: "openrouter-api",
        model: MODEL,
        preferredInferenceApi: "openai-completions",
      });
    },
  );
});

describe("Hermes native-local readiness authority", () => {
  function fixture(provider: string, agent: "hermes" | undefined) {
    const binding = {
      agent,
      provider: "vllm-local" as const,
      endpointUrl: "http://host.openshell.internal:8000/v1",
      gatewayName: "selected",
      sandboxName: "alpha",
      credentialEnv: "NEMOCLAW_LOCAL_INFERENCE_TOKEN",
      authMode: "authenticated" as const,
    };
    const receipt = {
      ...binding,
      ...nativeLocalIdentity(binding),
      schemaVersion: 1 as const,
      providerId: "owned",
    };
    return {
      sandboxName: "alpha",
      gatewayName: "selected",
      agentName: "hermes",
      entry: {
        name: "alpha",
        agent: "hermes",
        provider,
        model: "model-a",
        nativeLocalProviderAttachment: receipt,
      },
      deps: {
        verifyNativeLocalAttachment: vi.fn(async () => {}),
        inferenceInvocationProbe: vi.fn(async () => ({ ok: true as const })),
      },
    };
  }

  it.each([
    { name: "different selected provider", provider: "llama-cpp-local", agent: "hermes" as const },
    { name: "DCode attachment", provider: "vllm-local", agent: undefined },
  ])("rejects $name before observing or invoking the provider", async ({ provider, agent }) => {
    const input = fixture(provider, agent);
    await expect(requireNativeInferenceHealth(input)).rejects.toBeInstanceOf(
      LaunchReadinessEvidenceError,
    );
    expect(input.deps.verifyNativeLocalAttachment).not.toHaveBeenCalled();
    expect(input.deps.inferenceInvocationProbe).not.toHaveBeenCalled();
  });

  it("verifies and invokes the attached Hermes provider", async () => {
    const input = fixture("vllm-local", "hermes");
    await expect(requireNativeInferenceHealth(input)).resolves.toBe(true);
    expect(input.deps.verifyNativeLocalAttachment).toHaveBeenCalledExactlyOnceWith({
      sandboxName: "alpha",
      gatewayName: "selected",
      expected: input.entry.nativeLocalProviderAttachment,
    });
    expect(input.deps.inferenceInvocationProbe).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        agentName: "hermes",
        provider: "vllm-local",
        model: "model-a",
        nativeLocalProviderAttachment: input.entry.nativeLocalProviderAttachment,
      }),
    );
  });
});

describe("native NVIDIA diagnostic connect health (#13616)", () => {
  const entry = {
    name: "alpha",
    agent: "openclaw",
    provider: "nvidia-prod",
    model: "fixture-model",
    nativeNvidiaProviderAttachment: {
      schemaVersion: 1 as const,
      profileId: "nemoclaw-nvidia-inference-v1" as const,
      providerName: "nemoclaw-nvidia-prod-v1" as const,
      providerId: "owned-provider-id",
    },
  };

  it.each([429, 500])(
    "opens diagnostic connect after a trusted HTTP %i transient",
    async (httpStatus) => {
      const verifyNativeNvidiaAttachment = vi.fn(async () => {});
      const inferenceInvocationProbe = vi.fn(async () => ({
        ok: false as const,
        detail: `sandbox inference invocation probe returned HTTP ${httpStatus}`,
        httpStatus,
      }));
      const warning = vi.spyOn(console, "error").mockImplementation(() => undefined);
      await expect(
        requireNativeInferenceHealth({
          sandboxName: "alpha",
          gatewayName: "selected",
          entry,
          deps: { verifyNativeNvidiaAttachment, inferenceInvocationProbe },
          allowTransientNvidiaInvocation: true,
        }),
      ).resolves.toBe(true);
      expect(verifyNativeNvidiaAttachment).toHaveBeenCalledOnce();
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("inference is degraded"));
      warning.mockRestore();
    },
  );

  it.each([401, 403, 404])("refuses diagnostic connect after HTTP %i", async (httpStatus) => {
    await expect(
      requireNativeInferenceHealth({
        sandboxName: "alpha",
        gatewayName: "selected",
        entry,
        deps: {
          verifyNativeNvidiaAttachment: vi.fn(async () => {}),
          inferenceInvocationProbe: vi.fn(async () => ({
            ok: false as const,
            detail: `sandbox inference invocation probe returned HTTP ${httpStatus}`,
            httpStatus,
          })),
        },
        allowTransientNvidiaInvocation: true,
      }),
    ).rejects.toBeInstanceOf(LaunchReadinessObservationError);
  });
});

describe("OpenClaw native-local readiness identity (#13338)", () => {
  it.each([
    { agentName: undefined, agent: "openclaw" },
    { agentName: undefined, agent: undefined },
    { agentName: "openclaw", agent: "openclaw" },
  ])(
    "sends the health request to the recorded endpoint (selected $agentName, recorded $agent)",
    async ({ agentName, agent }) => {
      const receipt = nativeLocalTestReceipt(
        "llama-cpp-local",
        "http://host.openshell.internal:8081/v1",
        {
          agent: "openclaw",
          gatewayName: "selected",
        },
      );
      const shell = recordingProbeShell("200", '{"choices":[{"message":{"content":"OK"}}]}');
      await expect(
        requireNativeInferenceHealth({
          sandboxName: "alpha",
          gatewayName: "selected",
          ...(agentName ? { agentName } : {}),
          entry: {
            name: "alpha",
            ...(agent ? { agent } : {}),
            provider: "llama-cpp-local",
            model: "local-model",
            nativeLocalProviderAttachment: receipt,
          },
          deps: {
            verifyNativeLocalAttachment: vi.fn(async () => {}),
            inferenceInvocationProbe: (input) =>
              runSandboxInferenceInvocationProbe(input, (selected, _deps, timeoutMs) =>
                probeSandboxInferenceInvocation(selected, { execute: shell.execute }, timeoutMs),
              ),
          },
        }),
      ).resolves.toBe(true);
      expect(shell.destinations()).toEqual([
        "http://host.openshell.internal:8081/v1/chat/completions",
      ]);
      expect(shell.requests[0]).toContain(
        `Authorization: Bearer ${NATIVE_LOCAL_CREDENTIAL_HANDLE}`,
      );
    },
  );
});

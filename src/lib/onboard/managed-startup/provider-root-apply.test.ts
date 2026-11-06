// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  MANAGED_STARTUP_E2E_CORPORATE_CA_PEM,
  managedStartupE2eProfile,
} from "../../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import { createPodmanRuntimeProviderBundle } from "../runtime-provider/podman";
import type {
  RuntimeProviderBundle,
  RuntimeProviderPrivilegedSandboxCommandInput,
} from "../runtime-provider/contract";
import { MANAGED_STARTUP_SHARED_CAPTURE_MAX_BYTES } from "./shared-state-transaction";
import {
  DirectSandboxContainerNotFoundError,
  DirectSandboxFallbackUnavailableError,
} from "../runtime-provider/privileged-sandbox-control-errors";
import {
  PODMAN_MANAGED_LABEL,
  PODMAN_SANDBOX_CONTAINER_PREFIX,
  PODMAN_SANDBOX_ID_LABEL,
  PODMAN_SANDBOX_NAME_LABEL,
  PODMAN_SANDBOX_NAMESPACE_LABEL,
  PODMAN_SANDBOX_WORKSPACE,
  PODMAN_SANDBOX_WORKSPACE_LABEL,
} from "../runtime-provider/podman-lifecycle";
import { encodeManagedStartupProfile } from "./profile";
import {
  applyProviderManagedStartupRootRequest,
  finalizeProviderManagedStartupSharedState,
  releaseProviderManagedStartupHold,
} from "./provider-root-apply";
import { createManagedStartupRootApplyRequest } from "./root-apply";
import { buildConfig } from "../../../../scripts/generate-openclaw-config.mts";
import { mapManagedStartupProfileToAgentEnvironment } from "./agent-environment";
import { applyManagedStartupCommandEnvironmentPlan } from "./image-runtime";

const CONTAINER_ID = "a".repeat(64);
const IMAGE_ID = `sha256:${"b".repeat(64)}`;
const SANDBOX_ID = "sandbox-podman-managed";
const SANDBOX_NAME = "managed-podman";

type LifecycleFixtureProvider = RuntimeProviderBundle & {
  lifecycle: Extract<RuntimeProviderBundle["lifecycle"], { supported: true }>;
};

function createDockerRootApplyFixture(
  resolveTarget: (input: { readonly timeoutMs?: number }) => { resourceHandle: string },
  agent: Parameters<typeof createManagedStartupRootApplyRequest>[0]["agent"] = "openclaw",
) {
  const labels = {
    "openshell.ai/managed-by": "openshell",
    "openshell.ai/sandbox-name": SANDBOX_NAME,
    "openshell.ai/sandbox-id": SANDBOX_ID,
    "openshell.ai/sandbox-workspace": "default",
  };
  const execute = vi.fn((input: { readonly command: readonly string[] }) => ({
    status: input.command.includes("--startup-protocol") ? 1 : 0,
    stdout: input.command.includes("--shared-state-transaction-status") ? "pending\n" : "",
    stderr: input.command.includes("--startup-protocol")
      ? "usage: managed-startup-image-runtime --release-startup-hold"
      : "",
  }));
  const runtimeProvider = {
    identity: { id: "docker" },
    lifecycle: {
      supported: true,
      privilegedSandboxControl: { resolveTarget, execute, prepareManagedStartupWorkspace: vi.fn() },
    },
    containerEngine: {
      supported: true,
      identities: [{ operation: "sandbox-lifecycle" }],
      capture: () => ({
        status: 0,
        stdout: JSON.stringify([
          {
            Id: CONTAINER_ID,
            Image: IMAGE_ID,
            Config: { Labels: labels },
            State: { Dead: false, Paused: false, Restarting: false, Running: true },
          },
        ]),
        stderr: "",
      }),
    },
  } as unknown as LifecycleFixtureProvider;
  const request = createManagedStartupRootApplyRequest({
    agent,
    corporateCaB64: Buffer.from(MANAGED_STARTUP_E2E_CORPORATE_CA_PEM, "utf8").toString("base64"),
    encodedProfile: encodeManagedStartupProfile(managedStartupE2eProfile(agent, false, true, true)),
  });
  return { request, runtimeProvider };
}

function delegatedFixture(
  agent: Parameters<typeof createDockerRootApplyFixture>[1] = "openclaw",
  phase: "none" | "pending" | "committed" = "none",
) {
  const fixture = createDockerRootApplyFixture(() => ({ resourceHandle: CONTAINER_ID }), agent);
  const calls: Array<RuntimeProviderPrivilegedSandboxCommandInput & { sandboxUser?: string }> = [];
  const output: Record<string, string> = {
    "--startup-protocol": "delegated-owner-v1\n",
    "--prepare-delegated-transaction-stdin": phase,
    "--capture-shared-state-stdin": "private original capture",
    "--begin-shared-state-from-capture-stdin": "created\n",
    "--prepare-delegated-startup-stdin":
      phase === "committed" ? "already-committed\n" : "prepared\n",
    "--apply-owner-startup-stdin": "private generated result",
    "--finish-delegated-startup-stdin": "CA tool output\napplied\n",
    "--export-shared-restoration-profile-stdin": "private original capture",
    "--restore-shared-state-stdin": "private restored observation",
    "--finish-shared-restoration-stdin": "restored\n",
  };
  const failures = new Set<string>();
  const execute = vi.fn(
    (input: RuntimeProviderPrivilegedSandboxCommandInput & { sandboxUser?: string }) => {
      calls.push(input);
      const operation = input.command.find((value) => value.startsWith("--"))!;
      return {
        status: failures.has(operation) ? 1 : 0,
        signal: null,
        stdout: Buffer.from(output[operation] ?? ""),
        stderr: Buffer.from(failures.has(operation) ? "private-error-sentinel" : ""),
      };
    },
  );
  fixture.runtimeProvider.lifecycle.privilegedSandboxControl.execute = execute;
  fixture.runtimeProvider.lifecycle.privilegedSandboxControl.executeAsSandboxUser = execute;
  const input = {
    ...fixture,
    sandboxName: SANDBOX_NAME,
    sandboxId: SANDBOX_ID,
    bootstrapIdentity: "c".repeat(64),
    environment: {},
  };
  return { input, calls, output, failures, execute };
}

describe("provider delegated private startup", () => {
  it.each([
    ["openclaw", "998:998"],
    ["hermes", "998:999"],
    ["langchain-deepagents-code", "999:999"],
    ["pi", "999:999"],
  ] as const)(
    "orders %s capture, protected admission, generation and root finish",
    (agent, sandboxUser) => {
      const { input, calls } = delegatedFixture(agent);
      const transaction = applyProviderManagedStartupRootRequest(input);
      expect(transaction).toMatchObject({
        protocol: "identity-bound",
        delegatedProfile: input.request.encodedProfile,
      });
      expect(calls.map(({ command }) => command.find((value) => value.startsWith("--")))).toEqual([
        "--startup-protocol",
        "--prepare-delegated-transaction-stdin",
        "--capture-shared-state-stdin",
        "--begin-shared-state-from-capture-stdin",
        "--prepare-delegated-startup-stdin",
        "--apply-owner-startup-stdin",
        "--finish-delegated-startup-stdin",
      ]);
      expect(calls.filter((call) => call.sandboxUser).map((call) => call.sandboxUser)).toEqual([
        sandboxUser,
        sandboxUser,
      ]);
      expect(calls.every((call) => call.expectedResourceHandle === CONTAINER_ID)).toBe(true);
      expect(calls[2]?.maxOutputBytes).toBe(MANAGED_STARTUP_SHARED_CAPTURE_MAX_BYTES);
      expect(JSON.parse(String(calls[3]?.input))).toEqual({
        encodedProfile: input.request.encodedProfile,
        capturedState: "private original capture",
      });
      expect(JSON.parse(String(calls[6]?.input)).ownerResult).toBe("private generated result");
      expect(JSON.stringify(transaction)).not.toContain("private");
      expect(calls.flatMap((call) => call.command)).not.toContain("--release-startup-hold");
    },
  );

  it.each(["pending", "committed"] as const)(
    "keeps the original snapshot on %s recovery",
    (phase) => {
      const { input, calls } = delegatedFixture("openclaw", phase);
      applyProviderManagedStartupRootRequest(input);
      expect(calls.flatMap((call) => call.command)).not.toContain("--capture-shared-state-stdin");
      expect(calls.flatMap((call) => call.command)).not.toContain(
        "--begin-shared-state-from-capture-stdin",
      );
      const generation = calls.find((call) => call.command.includes("--apply-owner-startup-stdin"));
      expect(generation?.command.includes("--replay")).toBe(phase === "committed");
    },
  );

  it.each([
    "--prepare-delegated-transaction-stdin",
    "--capture-shared-state-stdin",
    "--begin-shared-state-from-capture-stdin",
    "--prepare-delegated-startup-stdin",
    "--apply-owner-startup-stdin",
    "--finish-delegated-startup-stdin",
  ])("retains recovery without leaking private output or falling back after %s fails", (action) => {
    const { input, calls, failures } = delegatedFixture();
    failures.add(action);
    let failure: Error & { managedStartupTransaction?: unknown };
    try {
      applyProviderManagedStartupRootRequest(input);
      throw new Error("expected failure");
    } catch (error) {
      failure = error as typeof failure;
    }
    expect(failure.message).toContain("retained for recovery");
    expect(failure.message).not.toContain("private-error-sentinel");
    expect(failure.managedStartupTransaction).toMatchObject({
      delegatedProfile: input.request.encodedProfile,
    });
    expect(calls.at(-1)?.command).toContain(action);
    expect(calls.flatMap((call) => call.command)).not.toContain("--apply-root-stdin");
  });

  it("rejects unknown protocol output before workspace changes", () => {
    const { input, output, calls } = delegatedFixture();
    output["--startup-protocol"] = "unknown";
    const prepare = vi.fn();
    input.runtimeProvider.lifecycle.privilegedSandboxControl.prepareManagedStartupWorkspace =
      prepare;
    expect(() => applyProviderManagedStartupRootRequest(input)).toThrow(/unknown protocol/u);
    expect(prepare).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  it("restores through the native owner and retires only its returned observation", () => {
    const { input, calls } = delegatedFixture();
    const transaction = applyProviderManagedStartupRootRequest(input);
    calls.length = 0;
    expect(
      finalizeProviderManagedStartupSharedState({ ...input, transaction, supervisorReady: false }),
    ).toEqual({ supervisorReady: false, failure: null });
    expect(calls.map(({ command }) => command.find((value) => value.startsWith("--")))).toEqual([
      "--export-shared-restoration-profile-stdin",
      "--restore-shared-state-stdin",
      "--finish-shared-restoration-stdin",
    ]);
    expect(String(calls[0]?.input)).toBe(input.request.encodedProfile);
    expect(calls[0]?.maxOutputBytes).toBe(MANAGED_STARTUP_SHARED_CAPTURE_MAX_BYTES);
    expect(calls[1]?.sandboxUser).toBe("998:998");
    expect(JSON.parse(String(calls[2]?.input))).toEqual({
      encodedProfile: input.request.encodedProfile,
      capturedState: "private restored observation",
    });
  });

  it.each([
    "--export-shared-restoration-profile-stdin",
    "--restore-shared-state-stdin",
    "--finish-shared-restoration-stdin",
  ])("retains recovery without root fallback when %s fails", (action) => {
    const { input, calls, failures } = delegatedFixture();
    const transaction = applyProviderManagedStartupRootRequest(input);
    calls.length = 0;
    failures.add(action);
    expect(() =>
      finalizeProviderManagedStartupSharedState({ ...input, transaction, supervisorReady: false }),
    ).toThrow(/recovery receipt are retained/u);
    expect(calls.at(-1)?.command).toContain(action);
    expect(calls.flatMap((call) => call.command)).not.toContain(
      "--rollback-shared-state-transaction",
    );
  });
});

describe("provider-owned managed startup root application", () => {
  it.each([
    ["openclaw", { uid: 998, gid: 998, mode: 0o755 }],
    ["hermes", { uid: 998, gid: 999, mode: 0o755 }],
    ["langchain-deepagents-code", { uid: 0, gid: 999, mode: 0o1775 }],
    ["pi", { uid: 999, gid: 999, mode: 0o755 }],
  ] as const)(
    "prepares %s workspace metadata before the first root application",
    (agent, workspace) => {
      const { request, runtimeProvider } = createDockerRootApplyFixture(
        () => ({
          resourceHandle: CONTAINER_ID,
        }),
        agent,
      );
      const control = runtimeProvider.lifecycle.privilegedSandboxControl;
      const prepare = vi.fn();
      control.prepareManagedStartupWorkspace = prepare;
      applyProviderManagedStartupRootRequest({
        runtimeProvider,
        sandboxName: SANDBOX_NAME,
        sandboxId: SANDBOX_ID,
        bootstrapIdentity: "c".repeat(64),
        request,
        environment: {},
      });
      expect(prepare).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          expectedResourceHandle: CONTAINER_ID,
          workspace,
        }),
      );
      expect(prepare.mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(control.execute).mock.invocationCallOrder[1]!,
      );
    },
  );

  it("generates the local compatible reference from the credential-free root apply environment", () => {
    const { runtimeProvider } = createDockerRootApplyFixture(() => ({
      resourceHandle: CONTAINER_ID,
    }));
    const profile = managedStartupE2eProfile("openclaw", false, true, true);
    const localProfile = {
      ...profile,
      inference: {
        ...profile.inference!,
        upstreamProvider: "compatible-endpoint",
        routedBaseUrl: "http://host.openshell.internal:45173/v1",
        api: "openai-completions" as const,
      },
    };
    const request = createManagedStartupRootApplyRequest({
      agent: "openclaw",
      encodedProfile: encodeManagedStartupProfile(localProfile),
      corporateCaB64: Buffer.from(MANAGED_STARTUP_E2E_CORPORATE_CA_PEM).toString("base64"),
    });
    applyProviderManagedStartupRootRequest({
      runtimeProvider,
      sandboxName: SANDBOX_NAME,
      sandboxId: SANDBOX_ID,
      bootstrapIdentity: "c".repeat(64),
      request,
      environment: {
        NEMOCLAW_LOCAL_INFERENCE_TOKEN: "openshell:resolve:env:v7_NEMOCLAW_LOCAL_INFERENCE_TOKEN",
        COMPATIBLE_API_KEY: "synthetic-host-secret",
      },
    });
    const command = vi
      .mocked(runtimeProvider.lifecycle.privilegedSandboxControl.execute)
      .mock.calls.map(([input]) => input.command)
      .find((argv) => argv.includes("--apply-root-stdin"))!;
    expect(command.slice(0, 2)).toEqual(["/usr/bin/env", "-i"]);
    const rootEnvironment = Object.fromEntries(
      command.slice(2, command.indexOf("/usr/local/bin/node")).map((entry) => {
        const separator = entry.indexOf("=");
        return [entry.slice(0, separator), entry.slice(separator + 1)];
      }),
    );
    const mapped = mapManagedStartupProfileToAgentEnvironment(localProfile, rootEnvironment);
    const generationEnvironment = applyManagedStartupCommandEnvironmentPlan(
      { ...rootEnvironment, ...mapped.configurationEnvironment },
      mapped.applicationRuntime,
    );
    expect(generationEnvironment.NEMOCLAW_LOCAL_INFERENCE_TOKEN).toBeUndefined();
    expect(generationEnvironment.COMPATIBLE_API_KEY).toBeUndefined();
    const config = buildConfig(generationEnvironment);
    expect(config.models.providers[localProfile.inference.routeProvider]).toMatchObject({
      baseUrl: localProfile.inference.routedBaseUrl,
      api: "openai-completions",
      apiKey: "openshell:resolve:env:NEMOCLAW_LOCAL_INFERENCE_TOKEN",
    });
  });

  it("rejects a provider without workspace preparation before root application", () => {
    const { request, runtimeProvider } = createDockerRootApplyFixture(() => ({
      resourceHandle: CONTAINER_ID,
    }));
    const control = runtimeProvider.lifecycle.privilegedSandboxControl;
    delete control.prepareManagedStartupWorkspace;
    expect(() =>
      applyProviderManagedStartupRootRequest({
        runtimeProvider,
        request,
        sandboxName: SANDBOX_NAME,
        sandboxId: SANDBOX_ID,
        bootstrapIdentity: "c".repeat(64),
        environment: {},
      }),
    ).toThrow(/cannot prepare the managed startup workspace/u);
    expect(control.execute).toHaveBeenCalledOnce();
    expect(vi.mocked(control.execute).mock.calls[0]?.[0].command).toContain("--startup-protocol");
  });

  it("does not start root application after workspace preparation fails", () => {
    const { request, runtimeProvider } = createDockerRootApplyFixture(() => ({
      resourceHandle: CONTAINER_ID,
    }));
    const control = runtimeProvider.lifecycle.privilegedSandboxControl;
    control.prepareManagedStartupWorkspace = () => {
      throw new Error("workspace changed");
    };
    expect(() =>
      applyProviderManagedStartupRootRequest({
        runtimeProvider,
        sandboxName: SANDBOX_NAME,
        sandboxId: SANDBOX_ID,
        bootstrapIdentity: "c".repeat(64),
        request,
        environment: {},
      }),
    ).toThrow(/workspace changed/u);
    expect(control.execute).toHaveBeenCalledOnce();
    expect(vi.mocked(control.execute).mock.calls[0]?.[0].command).toContain("--startup-protocol");
  });
  it("waits for the exact OpenShell container to appear after create returns", () => {
    const resolveTarget = vi
      .fn<() => { resourceHandle: string }>()
      .mockImplementationOnce(() => {
        throw new DirectSandboxContainerNotFoundError("container absent");
      })
      .mockImplementationOnce(() => {
        throw new DirectSandboxContainerNotFoundError("container absent");
      })
      .mockReturnValue({ resourceHandle: CONTAINER_ID });
    const { request, runtimeProvider } = createDockerRootApplyFixture(resolveTarget);
    const sleep = vi.fn();

    const transaction = applyProviderManagedStartupRootRequest(
      {
        runtimeProvider,
        sandboxName: SANDBOX_NAME,
        sandboxId: SANDBOX_ID,
        bootstrapIdentity: "c".repeat(64),
        request,
        environment: {},
      },
      { sleep },
    );

    expect(transaction?.containerId).toBe(CONTAINER_ID);
    expect(resolveTarget).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[250], [250]]);
  });

  it("fails with bounded evidence when the exact OpenShell container stays absent", () => {
    const resolveTarget = vi.fn(() => {
      throw new DirectSandboxContainerNotFoundError("container absent");
    });
    const { request, runtimeProvider } = createDockerRootApplyFixture(resolveTarget);
    const sleep = vi.fn();

    expect(() =>
      applyProviderManagedStartupRootRequest(
        {
          runtimeProvider,
          sandboxName: SANDBOX_NAME,
          sandboxId: SANDBOX_ID,
          bootstrapIdentity: "c".repeat(64),
          request,
          environment: {},
        },
        { sleep },
      ),
    ).toThrow(/remained absent after 21 observations over \d+ms \(budget 5000ms\)/u);
    expect(resolveTarget).toHaveBeenCalledTimes(21);
    expect(sleep).toHaveBeenCalledTimes(20);
  });

  it("bounds slow container discovery by the remaining handoff deadline", () => {
    let nowMs = 10_000;
    const resolveTarget = vi.fn((input: { readonly timeoutMs?: number }) => {
      nowMs += input.timeoutMs === 5_000 ? 3_000 : 2_000;
      throw new DirectSandboxContainerNotFoundError("container absent");
    });
    const { request, runtimeProvider } = createDockerRootApplyFixture(resolveTarget);
    const sleep = vi.fn();

    expect(() =>
      applyProviderManagedStartupRootRequest(
        {
          runtimeProvider,
          sandboxName: SANDBOX_NAME,
          sandboxId: SANDBOX_ID,
          bootstrapIdentity: "c".repeat(64),
          request,
          environment: {},
        },
        { now: () => nowMs, sleep },
      ),
    ).toThrow(/remained absent after 2 observations over 5000ms \(budget 5000ms\)/u);
    expect(resolveTarget).toHaveBeenCalledTimes(2);
    expect(resolveTarget.mock.calls.map(([input]) => input.timeoutMs)).toEqual([5_000, 2_000]);
    expect(sleep.mock.calls).toEqual([[250]]);
  });

  it("does not retry ambiguous container ownership", () => {
    const resolveTarget = vi.fn(() => {
      throw new DirectSandboxFallbackUnavailableError("ambiguous container ownership");
    });
    const { request, runtimeProvider } = createDockerRootApplyFixture(resolveTarget);
    const sleep = vi.fn();

    expect(() =>
      applyProviderManagedStartupRootRequest(
        {
          runtimeProvider,
          sandboxName: SANDBOX_NAME,
          sandboxId: SANDBOX_ID,
          bootstrapIdentity: "c".repeat(64),
          request,
          environment: {},
        },
        { sleep },
      ),
    ).toThrow(/ambiguous container ownership/u);
    expect(resolveTarget).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries a failed hold release on resume through the same exact Podman runtime", () => {
    const calls: Array<{ args: readonly string[]; input?: Buffer }> = [];
    let committed = false;
    let releaseAttempts = 0;
    let workspace = { uid: 0, gid: 0, mode: 0o700, dev: "1", ino: "2", mtime: 100 };
    const inspect = JSON.stringify([
      {
        Id: CONTAINER_ID,
        Image: IMAGE_ID,
        Name: `${PODMAN_SANDBOX_CONTAINER_PREFIX}${SANDBOX_NAME}-${SANDBOX_ID}`,
        Config: {
          Labels: {
            [PODMAN_MANAGED_LABEL]: "true",
            [PODMAN_SANDBOX_ID_LABEL]: SANDBOX_ID,
            [PODMAN_SANDBOX_NAME_LABEL]: SANDBOX_NAME,
            [PODMAN_SANDBOX_NAMESPACE_LABEL]: "",
            [PODMAN_SANDBOX_WORKSPACE_LABEL]: PODMAN_SANDBOX_WORKSPACE,
          },
        },
        Mounts: [],
        State: { Dead: false, Paused: false, Restarting: false, Running: true, Status: "running" },
      },
    ]);
    const capture = vi.fn((args: readonly string[], _timeoutMs?: number, input?: Buffer) => {
      calls.push({ args, ...(input ? { input } : {}) });
      const operation = [
        "--startup-protocol",
        "--shared-state-transaction-status",
        "--commit-shared-state-transaction",
        "--release-startup-hold",
      ].find((candidate) => args.includes(candidate));
      switch (operation) {
        case "--startup-protocol":
          return {
            status: 1,
            stdout: "",
            stderr: "usage: managed-startup-image-runtime --release-startup-hold",
          };
        case "--shared-state-transaction-status":
          return { status: 0, stdout: committed ? "committed\n" : "pending\n", stderr: "" };
        case "--commit-shared-state-transaction":
          committed = true;
          break;
        case "--release-startup-hold":
          releaseAttempts += 1;
          switch (releaseAttempts) {
            case 1:
              return { status: 1, stdout: "", stderr: "release unavailable" };
          }
          break;
      }
      switch (`${String(args[0])}:${String(args[1])}`) {
        case "container:cp":
          workspace = { ...workspace, uid: 998, gid: 998, mode: 0o755 };
          return { status: 0, stdout: "", stderr: "" };
        case "container:exec":
          return { status: 0, stdout: JSON.stringify(workspace), stderr: "" };
        case "ps:--all":
          return { status: 0, stdout: `${CONTAINER_ID}\n`, stderr: "" };
        case "container:inspect":
        case "inspect:--type":
          return { status: 0, stdout: inspect, stderr: "" };
        default:
          return { status: 0, stdout: "", stderr: "" };
      }
    });
    const engine = (operation: string) => ({
      operation,
      engineId: "podman",
      displayName: "Podman",
      authorityId: "podman:test",
      endpointAuthorityId: "podman:test",
      capture,
      captureHost: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
    });
    const runtimeProvider = createPodmanRuntimeProviderBundle({
      engines: {
        hostDoctor: engine("host-doctor") as never,
        sandboxLifecycle: engine("sandbox-lifecycle") as never,
      },
    });
    const profile = managedStartupE2eProfile("openclaw", false, true, true);
    const request = createManagedStartupRootApplyRequest({
      agent: "openclaw",
      corporateCaB64: Buffer.from(MANAGED_STARTUP_E2E_CORPORATE_CA_PEM, "utf8").toString("base64"),
      encodedProfile: encodeManagedStartupProfile(profile),
    });
    const transaction = applyProviderManagedStartupRootRequest({
      runtimeProvider,
      sandboxName: SANDBOX_NAME,
      sandboxId: SANDBOX_ID,
      bootstrapIdentity: "c".repeat(64),
      request,
      environment: {},
    });

    const copyIndex = calls.findIndex(({ args }) => args[1] === "cp");
    expect(copyIndex).toBeGreaterThan(0);
    expect(calls[copyIndex]?.args).toEqual([
      "container",
      "cp",
      "--archive=false",
      "-",
      `${CONTAINER_ID}:/`,
    ]);
    expect(calls[copyIndex]?.input?.length).toBe(1536);
    expect(copyIndex).toBeLessThan(
      calls.findIndex(({ args }) => args.includes("--apply-root-stdin")),
    );
    expect(workspace).toEqual({ uid: 998, gid: 998, mode: 0o755, dev: "1", ino: "2", mtime: 100 });
    expect(transaction).toMatchObject({
      containerId: CONTAINER_ID,
      image: IMAGE_ID,
      providerId: "podman",
    });
    expect(
      finalizeProviderManagedStartupSharedState({
        runtimeProvider,
        sandboxName: SANDBOX_NAME,
        sandboxId: SANDBOX_ID,
        transaction,
        supervisorReady: true,
      }),
    ).toEqual({ supervisorReady: true, failure: null });
    expect(() =>
      releaseProviderManagedStartupHold({
        runtimeProvider,
        sandboxName: SANDBOX_NAME,
        sandboxId: SANDBOX_ID,
        transaction: transaction!,
        profileFingerprint: request.profileFingerprint,
      }),
    ).toThrow(/release unavailable/u);
    const resumedTransaction = applyProviderManagedStartupRootRequest({
      runtimeProvider,
      sandboxName: SANDBOX_NAME,
      sandboxId: SANDBOX_ID,
      bootstrapIdentity: "c".repeat(64),
      request,
      environment: {},
    });
    expect(resumedTransaction).toEqual(transaction);
    expect(
      finalizeProviderManagedStartupSharedState({
        runtimeProvider,
        sandboxName: SANDBOX_NAME,
        sandboxId: SANDBOX_ID,
        transaction: resumedTransaction,
        supervisorReady: true,
      }),
    ).toEqual({ supervisorReady: true, failure: null });
    releaseProviderManagedStartupHold({
      runtimeProvider,
      sandboxName: SANDBOX_NAME,
      sandboxId: SANDBOX_ID,
      transaction: resumedTransaction!,
      profileFingerprint: request.profileFingerprint,
    });

    expect(calls.some(({ args }) => args.includes("--apply-root-stdin"))).toBe(true);
    expect(calls.some(({ args }) => args.includes("--commit-shared-state-transaction"))).toBe(true);
    expect(calls.some(({ args }) => args.includes("--release-startup-hold"))).toBe(true);
    expect(releaseAttempts).toBe(2);
    expect(JSON.stringify(calls.map(({ args }) => args))).not.toContain("docker");
  });

  it("uses the published base-image unbound protocol without explicit hold release", () => {
    const labels = {
      "openshell.ai/managed-by": "openshell",
      "openshell.ai/sandbox-name": SANDBOX_NAME,
      "openshell.ai/sandbox-id": SANDBOX_ID,
      "openshell.ai/sandbox-workspace": "default",
    };
    const capture = vi.fn(() => ({
      status: 0,
      stdout: JSON.stringify([
        {
          Id: CONTAINER_ID,
          Image: IMAGE_ID,
          Config: { Labels: labels },
          State: { Dead: false, Paused: false, Restarting: false, Running: true },
        },
      ]),
      stderr: "",
    }));
    const execute = vi.fn((input: { readonly command: readonly string[] }) => {
      const operation = [
        "--startup-protocol",
        "--apply-root-stdin",
        "--commit-shared-state-transaction",
        "--release-startup-hold",
      ].find((candidate) => input.command.includes(candidate));
      switch (`${String(operation)}:${String(input.command.includes("--bootstrap-identity"))}`) {
        case "--startup-protocol:false":
        case "--startup-protocol:true":
          return {
            status: 1,
            stdout: "",
            stderr: "usage: managed-startup-image-runtime --apply-root-stdin",
          };
        case "--apply-root-stdin:true":
          return {
            status: 1,
            stdout: "",
            stderr:
              "usage: managed-startup-image-runtime [--apply-root-stdin|--wait-for-completion] --agent <agent>",
          };
        case "--apply-root-stdin:false":
        case "--commit-shared-state-transaction:false":
          return { status: 0, stdout: "", stderr: "" };
        default:
          return { status: 1, stdout: "", stderr: "unexpected command" };
      }
    });
    const runtimeProvider = {
      identity: { id: "docker" },
      lifecycle: {
        supported: true,
        privilegedSandboxControl: {
          resolveTarget: () => ({ resourceHandle: CONTAINER_ID }),
          prepareManagedStartupWorkspace: vi.fn(),
          execute,
        },
      },
      containerEngine: {
        supported: true,
        identities: [{ operation: "sandbox-lifecycle" }],
        capture,
      },
    } as unknown as RuntimeProviderBundle;
    const request = createManagedStartupRootApplyRequest({
      agent: "openclaw",
      corporateCaB64: Buffer.from(MANAGED_STARTUP_E2E_CORPORATE_CA_PEM, "utf8").toString("base64"),
      encodedProfile: encodeManagedStartupProfile(
        managedStartupE2eProfile("openclaw", false, true, true),
      ),
    });

    const transaction = applyProviderManagedStartupRootRequest({
      runtimeProvider,
      sandboxName: SANDBOX_NAME,
      sandboxId: SANDBOX_ID,
      bootstrapIdentity: "c".repeat(64),
      request,
      environment: {},
    });

    expect(transaction).toMatchObject({ protocol: "legacy-unbound" });
    expect(
      finalizeProviderManagedStartupSharedState({
        runtimeProvider,
        sandboxName: SANDBOX_NAME,
        sandboxId: SANDBOX_ID,
        transaction,
        supervisorReady: true,
      }),
    ).toEqual({ supervisorReady: true, failure: null });
    releaseProviderManagedStartupHold({
      runtimeProvider,
      sandboxName: SANDBOX_NAME,
      sandboxId: SANDBOX_ID,
      transaction: transaction!,
      profileFingerprint: request.profileFingerprint,
    });

    expect(execute).toHaveBeenCalledTimes(4);
    expect(execute.mock.calls[3]?.[0].command).not.toContain("--bootstrap-identity");
    expect(
      execute.mock.calls.some(([input]) => input.command.includes("--release-startup-hold")),
    ).toBe(false);
  });

  it.each(["docker", "podman"] as const)(
    "rolls back a definitive %s commit failure inside the exact sandbox without stop or removal",
    (providerId) => {
      const labels = {
        ...(providerId === "docker"
          ? { "openshell.ai/managed-by": "openshell" }
          : { "openshell.managed": "true" }),
        "openshell.ai/sandbox-name": SANDBOX_NAME,
        "openshell.ai/sandbox-id": SANDBOX_ID,
        "openshell.ai/sandbox-workspace": "default",
      };
      const capture = vi.fn((_args: readonly string[], _timeoutMs?: number) => ({
        status: 0,
        stdout: JSON.stringify([
          {
            Id: CONTAINER_ID,
            Image: IMAGE_ID,
            Config: { Labels: labels },
            State: { Dead: false, Paused: false, Restarting: false, Running: true },
          },
        ]),
        stderr: "",
      }));
      const execute = vi
        .fn((_input: { readonly command: readonly string[] }) => ({
          status: 0,
          stdout: "",
          stderr: "",
        }))
        .mockReturnValueOnce({ status: 1, stdout: "", stderr: "commit rejected" })
        .mockReturnValueOnce({ status: 0, stdout: "restored", stderr: "" });
      const runtimeProvider = {
        identity: { id: providerId },
        lifecycle: {
          supported: true,
          privilegedSandboxControl: {
            resolveTarget: () => ({ resourceHandle: CONTAINER_ID }),
            execute,
          },
        },
        containerEngine: {
          supported: true,
          identities: [{ operation: "sandbox-lifecycle" }],
          capture: (_operation: string, args: readonly string[], timeoutMs?: number) =>
            capture(args, timeoutMs),
        },
      } as unknown as RuntimeProviderBundle;

      const outcome = finalizeProviderManagedStartupSharedState({
        runtimeProvider,
        sandboxName: SANDBOX_NAME,
        sandboxId: SANDBOX_ID,
        transaction: {
          agent: "openclaw",
          bootstrapIdentity: "c".repeat(64),
          containerId: CONTAINER_ID,
          image: IMAGE_ID,
          protocol: "identity-bound",
          providerId,
        },
        supervisorReady: true,
      });

      expect(outcome.supervisorReady).toBe(false);
      expect(outcome.failure?.message).toContain("commit rejected");
      expect(execute).toHaveBeenCalledTimes(2);
      expect(execute.mock.calls[0]?.[0].command).toContain("--commit-shared-state-transaction");
      expect(execute.mock.calls[1]?.[0].command).toContain("--rollback-shared-state-transaction");
      expect(capture.mock.calls.flatMap(([args]) => args)).not.toEqual(
        expect.arrayContaining(["stop", "rm", "--force"]),
      );
    },
  );
});

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  MANAGED_STARTUP_E2E_CORPORATE_CA_PEM,
  managedStartupE2eProfile,
} from "../../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import { createPodmanRuntimeProviderBundle } from "../runtime-provider/podman";
import type { RuntimeProviderBundle } from "../runtime-provider/contract";
import { fingerprintOpenShellSandboxId } from "../../adapters/openshell/sandbox-identity";
import type { OpenShellSandboxStateLifecycle } from "../../adapters/openshell/sandbox-lifecycle-sdk";
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
  refreshProviderManagedStartupTrust,
  resumeProviderManagedStartupTrust,
  releaseProviderManagedStartupHold,
  type ProviderManagedStartupTransaction,
} from "./provider-root-apply";
import { createManagedStartupRootApplyRequest } from "./root-apply";

const CONTAINER_ID = "a".repeat(64);
const IMAGE_ID = `sha256:${"b".repeat(64)}`;
const SANDBOX_ID = "sandbox-podman-managed";
const SANDBOX_NAME = "managed-podman";

function trustRefreshFixture(providerId: "docker" | "podman" = "podman") {
  const events: string[] = [];
  const row = {
    Id: CONTAINER_ID,
    Image: IMAGE_ID,
    Config: {
      Labels: {
        "openshell.ai/managed-by": "openshell",
        "openshell.managed": "true",
        "openshell.ai/sandbox-name": SANDBOX_NAME,
        "openshell.ai/sandbox-id": SANDBOX_ID,
        "openshell.ai/sandbox-workspace": "default",
      },
    },
    State: { Running: true, Paused: false, Restarting: false, Dead: false },
  };
  const capture = vi.fn((_operation: string, _args: readonly string[]) => {
    events.push(`inspect:${String(row.State.Running)}`);
    return { status: 0, stdout: JSON.stringify([row]), stderr: "" };
  });
  const execute = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
  const runtimeProvider = {
    identity: { id: providerId },
    lifecycle: {
      supported: true,
      privilegedSandboxControl: {
        resolveTarget: () => ({ resourceHandle: CONTAINER_ID }),
        execute,
      },
    },
    containerEngine: { supported: true, identities: [{ operation: "sandbox-lifecycle" }], capture },
  } as unknown as RuntimeProviderBundle;
  const lifecycle = {
    stopSandbox: vi.fn<OpenShellSandboxStateLifecycle["stopSandbox"]>(async () => {
      events.push("stop");
      row.State.Running = false;
      return { kind: "accepted" };
    }),
    startSandbox: vi.fn<OpenShellSandboxStateLifecycle["startSandbox"]>(async () => {
      events.push("start");
      row.State.Running = true;
      return { kind: "accepted" };
    }),
  };
  const transaction: ProviderManagedStartupTransaction = {
    agent: "openclaw",
    bootstrapIdentity: "c".repeat(64),
    containerId: CONTAINER_ID,
    image: IMAGE_ID,
    protocol: "identity-bound",
    providerId,
  };
  const input = {
    runtimeProvider,
    sandboxName: SANDBOX_NAME,
    sandboxId: SANDBOX_ID,
    gatewayName: "selected-gateway",
    transaction,
    corporateCa: true,
    route: "none" as const,
  };
  return { input, lifecycle, capture, execute, events, row };
}

describe("managed startup corporate CA activation", () => {
  it("leaves compatibility restart ownership with its existing final handoff", async () => {
    const fixture = trustRefreshFixture();
    const input = { ...fixture.input, route: "compatibility" as const };
    await resumeProviderManagedStartupTrust(input, fixture.lifecycle);
    await refreshProviderManagedStartupTrust(input, fixture.lifecycle);
    expect(fixture.events).toEqual([]);
  });

  it.each([refreshProviderManagedStartupTrust, resumeProviderManagedStartupTrust])(
    "rejects an absent sandbox identity before inspecting or mutating the runtime (%#)",
    async (operation) => {
      const fixture = trustRefreshFixture();
      await expect(
        operation({ ...fixture.input, sandboxId: "" }, fixture.lifecycle),
      ).rejects.toThrow("verified sandbox identity");
      expect(fixture.events).toEqual([]);
    },
  );

  it("resumes a stopped sandbox after interruption between trust-refresh stop and start", async () => {
    const fixture = trustRefreshFixture();
    fixture.row.State.Running = false;
    await resumeProviderManagedStartupTrust(fixture.input, fixture.lifecycle);
    expect(fixture.row.State.Running).toBe(true);
    expect(fixture.lifecycle.startSandbox).toHaveBeenCalledExactlyOnceWith({
      sandboxName: SANDBOX_NAME,
      sandboxIdentityFingerprint: fingerprintOpenShellSandboxId(SANDBOX_ID),
      target: { kind: "named", gatewayName: "selected-gateway" },
      timeoutMs: 75_000,
    });
    expect(fixture.lifecycle.stopSandbox).not.toHaveBeenCalled();
  });

  it("preserves resume without a corporate CA and propagates identity rejection with one", async () => {
    const fixture = trustRefreshFixture();
    await resumeProviderManagedStartupTrust(
      { ...fixture.input, corporateCa: false },
      fixture.lifecycle,
    );
    expect(fixture.lifecycle.startSandbox).not.toHaveBeenCalled();
    fixture.lifecycle.startSandbox.mockResolvedValueOnce({
      kind: "failed",
      error: {
        kind: "transport",
        reason: "identity_mismatch",
        message: "sandbox identity changed",
      },
    });
    await expect(
      resumeProviderManagedStartupTrust(fixture.input, fixture.lifecycle),
    ).rejects.toThrow("sandbox identity changed");
    expect(fixture.lifecycle.startSandbox).toHaveBeenCalledTimes(1);
  });

  it.each(["docker", "podman"] as const)(
    "refreshes %s trust through the same stopped and restarted sandbox",
    async (providerId) => {
      const fixture = trustRefreshFixture(providerId);
      await refreshProviderManagedStartupTrust(fixture.input, fixture.lifecycle);
      expect(fixture.events).toEqual([
        "inspect:true",
        "stop",
        "inspect:false",
        "start",
        "inspect:true",
      ]);
      const request = {
        sandboxName: SANDBOX_NAME,
        sandboxIdentityFingerprint: fingerprintOpenShellSandboxId(SANDBOX_ID),
        target: { kind: "named", gatewayName: "selected-gateway" },
        timeoutMs: 75_000,
      };
      expect(fixture.lifecycle.stopSandbox).toHaveBeenCalledExactlyOnceWith(request);
      expect(fixture.lifecycle.startSandbox).toHaveBeenCalledExactlyOnceWith(request);
      expect(fixture.capture.mock.calls.every(([, args]) => args[3] === CONTAINER_ID)).toBe(true);
      expect(fixture.execute).not.toHaveBeenCalled();
    },
  );

  it("leaves onboarding without a corporate CA unchanged", async () => {
    const fixture = trustRefreshFixture();
    await refreshProviderManagedStartupTrust(
      { ...fixture.input, corporateCa: false },
      fixture.lifecycle,
    );
    expect(fixture.events).toEqual([]);
  });

  it("refreshes an already-applied profile that has no pending transaction", async () => {
    const fixture = trustRefreshFixture();
    await refreshProviderManagedStartupTrust(
      { ...fixture.input, transaction: null },
      fixture.lifecycle,
    );
    expect(fixture.lifecycle.startSandbox).toHaveBeenCalledTimes(1);
    expect(fixture.events.at(-1)).toBe("inspect:true");
  });

  it.each([
    { stage: "stopSandbox", starts: 0 },
    { stage: "startSandbox", starts: 1 },
  ] as const)(
    "retains failure when $stage cannot establish its result",
    async ({ stage, starts }) => {
      const fixture = trustRefreshFixture();
      fixture.lifecycle[stage].mockResolvedValueOnce({
        kind: "failed",
        error: { kind: "timeout", message: "deadline expired" },
      });
      await expect(
        refreshProviderManagedStartupTrust(fixture.input, fixture.lifecycle),
      ).rejects.toThrow("deadline expired");
      expect(fixture.lifecycle.stopSandbox).toHaveBeenCalledTimes(1);
      expect(fixture.lifecycle.startSandbox).toHaveBeenCalledTimes(starts);
      expect(fixture.execute).not.toHaveBeenCalled();
    },
  );

  it.each([
    { inspection: 1, stops: 0, starts: 0 },
    { inspection: 2, stops: 1, starts: 0 },
    { inspection: 3, stops: 1, starts: 1 },
  ])(
    "rejects image replacement at inspection $inspection",
    async ({ inspection, stops, starts }) => {
      const fixture = trustRefreshFixture();
      let reads = 0;
      fixture.capture.mockImplementation(() => {
        reads += 1;
        return {
          status: 0,
          stdout: JSON.stringify([
            { ...fixture.row, Image: reads === inspection ? `sha256:${"d".repeat(64)}` : IMAGE_ID },
          ]),
          stderr: "",
        };
      });
      await expect(
        refreshProviderManagedStartupTrust(fixture.input, fixture.lifecycle),
      ).rejects.toThrow("runtime identity changed");
      expect(fixture.lifecycle.stopSandbox).toHaveBeenCalledTimes(stops);
      expect(fixture.lifecycle.startSandbox).toHaveBeenCalledTimes(starts);
    },
  );

  it("refuses to start a runtime that remained running after stop acknowledgement", async () => {
    const fixture = trustRefreshFixture();
    fixture.lifecycle.stopSandbox.mockResolvedValueOnce({ kind: "accepted" });
    await expect(
      refreshProviderManagedStartupTrust(fixture.input, fixture.lifecycle),
    ).rejects.toThrow("exact managed-startup container");
    expect(fixture.lifecycle.startSandbox).not.toHaveBeenCalled();
  });
});

describe("provider-owned managed startup root application", () => {
  it("retries a failed hold release on resume through the same exact Podman runtime", () => {
    const calls: Array<{ args: readonly string[]; input?: Buffer }> = [];
    let committed = false;
    let releaseAttempts = 0;
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
        "--shared-state-transaction-status",
        "--commit-shared-state-transaction",
        "--release-startup-hold",
      ].find((candidate) => args.includes(candidate));
      switch (operation) {
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
        "--apply-root-stdin",
        "--commit-shared-state-transaction",
        "--release-startup-hold",
      ].find((candidate) => input.command.includes(candidate));
      switch (`${String(operation)}:${String(input.command.includes("--bootstrap-identity"))}`) {
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

    expect(execute).toHaveBeenCalledTimes(3);
    expect(execute.mock.calls[2]?.[0].command).not.toContain("--bootstrap-identity");
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

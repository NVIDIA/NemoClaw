// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  MANAGED_STARTUP_E2E_CORPORATE_CA_PEM,
  managedStartupE2eProfile,
} from "../../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import { createPodmanRuntimeProviderBundle } from "../runtime-provider/podman";
import type { RuntimeProviderBundle } from "../runtime-provider/contract";
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

const CONTAINER_ID = "a".repeat(64);
const IMAGE_ID = `sha256:${"b".repeat(64)}`;
const SANDBOX_ID = "sandbox-podman-managed";
const SANDBOX_NAME = "managed-podman";

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

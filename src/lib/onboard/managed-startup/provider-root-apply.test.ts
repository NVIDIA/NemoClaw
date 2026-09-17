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
  it("applies, commits, and releases through the exact Podman runtime", () => {
    const calls: Array<{ args: readonly string[]; input?: Buffer }> = [];
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
    releaseProviderManagedStartupHold({
      runtimeProvider,
      sandboxName: SANDBOX_NAME,
      sandboxId: SANDBOX_ID,
      transaction: transaction!,
      profileFingerprint: request.profileFingerprint,
    });

    expect(calls.some(({ args }) => args.includes("--apply-root-stdin"))).toBe(true);
    expect(calls.some(({ args }) => args.includes("--commit-shared-state-transaction"))).toBe(true);
    expect(calls.some(({ args }) => args.includes("--release-startup-hold"))).toBe(true);
    expect(JSON.stringify(calls.map(({ args }) => args))).not.toContain("docker");
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

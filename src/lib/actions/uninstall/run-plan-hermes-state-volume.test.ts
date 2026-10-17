// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { PodmanBoundContainerEngine } from "../../adapters/podman";
import { createHermesStateVolumeDockerHarness } from "../../onboard/__test-helpers__/hermes-state-volume";
import { createPodmanRuntimeProviderBundle } from "../../onboard/runtime-provider/podman";
import { createRuntimeProviderBundleRegistry } from "../../onboard/runtime-provider/registry";
import { removeManagedStateVolumesForUninstall } from "./managed-state-uninstall-cleanup";
import { runManagedHermesVolumeUninstall } from "../../../../test/support/uninstall-state-volume";

describe("managed agent state volume uninstall", () => {
  it("dispatches a Podman-owned volume through provider cleanup authority", () => {
    const volume = createHermesStateVolumeDockerHarness();
    volume.runDocker([
      "create",
      "--label",
      "io.nvidia.nemoclaw.hermes-state.managed=true",
      "--label",
      "io.nvidia.nemoclaw.hermes-state.sandbox=hermes",
      "--label",
      "io.nvidia.nemoclaw.hermes-state.schema=1",
      "--label",
      "io.nvidia.nemoclaw.hermes-state.target=/sandbox/.hermes",
      "nemoclaw-hermes-state-v1-hermes",
    ]);
    const capture = vi.fn((args: readonly string[]) => {
      const result = volume.runDocker(args.slice(1));
      return {
        status: result.status ?? 1,
        stdout: String(result.stdout ?? ""),
        stderr: String(result.stderr ?? ""),
      };
    });
    const engine = (
      operation: PodmanBoundContainerEngine["operation"],
      operationCapture = vi.fn(),
    ) =>
      ({
        operation,
        engineId: "podman",
        displayName: "Podman",
        authorityId: `podman:${operation}`,
        endpointAuthorityId: "podman:test-endpoint",
        capture: operationCapture,
        captureHost: operationCapture,
        assertAuthority: vi.fn(),
      }) satisfies PodmanBoundContainerEngine;
    const provider = createPodmanRuntimeProviderBundle({
      engines: {
        hostDoctor: engine("host-doctor"),
        sandboxLifecycle: engine("sandbox-lifecycle"),
        workloadCleanup: engine("workload-cleanup", capture),
      },
    });
    const runDocker = vi.fn(() => {
      throw new Error("Podman uninstall reached Docker");
    });

    expect(
      removeManagedStateVolumesForUninstall(
        [
          {
            agentName: "hermes",
            runtimeProviderId: "podman",
            sandboxName: "hermes",
            workloadKind: "managed-image",
          },
        ],
        {
          env: {},
          error: vi.fn(),
          log: vi.fn(),
          runDocker,
          runtimeProviders: createRuntimeProviderBundleRegistry([["podman", provider]]),
          warn: vi.fn(),
        },
      ),
    ).toBe(true);
    expect(capture).toHaveBeenCalledWith(
      ["volume", "rm", "nemoclaw-hermes-state-v1-hermes"],
      30_000,
    );
    expect(runDocker).not.toHaveBeenCalled();
  });

  it.each([
    ["hermes", false],
    ["hermes", true],
    ["openclaw", false],
    ["openclaw", true],
  ] as const)(
    "removes an owned %s volume with destroy-user-data=%s",
    async (agent, destroyUserData) => {
      const harness = await runManagedHermesVolumeUninstall(
        "owned",
        destroyUserData,
        "absent",
        agent,
      );
      try {
        expect(harness.result.exitCode, harness.errors.join("\n")).toBe(0);
        expect(harness.volumePresent()).toBe(false);
        expect(harness.dockerCalls).toContainEqual(["volume", "rm", harness.volumeName]);
        expect(harness.events.indexOf("openshell sandbox delete --all")).toBeLessThan(
          harness.events.indexOf(`docker volume rm ${harness.volumeName}`),
        );
        expect(harness.logs).toContain("Removed managed agent state volume for 'hermes'.");
      } finally {
        harness.cleanup();
      }
    },
  );

  it("keeps a same-name foreign volume", async () => {
    const harness = await runManagedHermesVolumeUninstall("foreign", true);
    try {
      expect(harness.result.exitCode, harness.errors.join("\n")).toBe(0);
      expect(harness.volumePresent()).toBe(true);
      expect(harness.dockerCalls).not.toContainEqual(["volume", "rm", harness.volumeName]);
      expect(harness.errors.join("\n")).toContain(
        `Left managed state volume '${harness.volumeName}' untouched because the exact NemoClaw ownership labels are absent or changed.`,
      );
    } finally {
      harness.cleanup();
    }
  });

  it("preserves uninstall state when volume removal fails", async () => {
    const harness = await runManagedHermesVolumeUninstall("remove-fails", true);
    try {
      expect(harness.result.exitCode).toBe(1);
      expect(harness.volumePresent()).toBe(true);
      expect(fs.existsSync(harness.registryFile)).toBe(true);
      expect(harness.events.some((event) => event.startsWith("npm "))).toBe(false);
      expect(harness.errors).toContain(
        `Managed agent state volume '${harness.volumeName}' could not be removed.`,
      );
      expect(harness.errors).toContain("Preserved NemoClaw state so exact cleanup can be retried.");
    } finally {
      harness.cleanup();
    }
  });

  it("retries volume cleanup before removing the gateway registration", async () => {
    const harness = await runManagedHermesVolumeUninstall("remove-fails-once", true);
    try {
      expect(harness.result.exitCode).toBe(1);
      expect(harness.gatewayRegistered()).toBe(true);
      expect(harness.volumePresent()).toBe(true);
      expect(fs.existsSync(harness.registryFile)).toBe(true);

      const retry = await harness.retry();

      expect(retry.exitCode, harness.errors.join("\n")).toBe(0);
      expect(harness.gatewayRegistered()).toBe(false);
      expect(harness.volumePresent()).toBe(false);
      expect(fs.existsSync(harness.registryFile)).toBe(false);
    } finally {
      harness.cleanup();
    }
  });

  it("preserves a stopped sandbox and its state when the owning runtime leaves it behind", async () => {
    const harness = await runManagedHermesVolumeUninstall("owned", true, "owned");
    try {
      expect(harness.result.exitCode).toBe(1);
      expect(harness.containerPresent()).toBe(true);
      expect(harness.volumePresent()).toBe(true);
      expect(harness.dockerCalls).not.toContainEqual(["rm", "-f", harness.containerId]);
      expect(harness.dockerCalls).not.toContainEqual(["volume", "rm", harness.volumeName]);
      expect(fs.existsSync(harness.registryFile)).toBe(true);
      expect(harness.errors.join("\n")).toContain("sandboxes are absent: hermes");
    } finally {
      harness.cleanup();
    }
  });

  it("keeps a foreign container that prevents Hermes state volume removal", async () => {
    const harness = await runManagedHermesVolumeUninstall("owned", true, "foreign");
    try {
      expect(harness.result.exitCode).toBe(1);
      expect(harness.containerPresent()).toBe(true);
      expect(harness.volumePresent()).toBe(true);
      expect(harness.dockerCalls).not.toContainEqual(["rm", "-f", harness.containerId]);
      expect(fs.existsSync(harness.registryFile)).toBe(true);
    } finally {
      harness.cleanup();
    }
  });
});

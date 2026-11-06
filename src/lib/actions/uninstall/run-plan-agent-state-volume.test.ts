// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { PodmanBoundContainerEngine } from "../../adapters/podman";
import { createHermesStateVolumeDockerHarness } from "../../onboard/__test-helpers__/hermes-state-volume";
import { createPodmanRuntimeProviderBundle } from "../../onboard/runtime-provider/podman";
import { createRuntimeProviderBundleRegistry } from "../../onboard/runtime-provider/registry";
import { removeManagedAgentStateVolumesForUninstall } from "./agent-state-volume-cleanup";
import { runManagedHermesVolumeUninstall } from "../../../../test/support/uninstall-state-volume";

describe("managed agent state volume uninstall", () => {
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

const MANAGED_HERMES_VOLUME_LABELS = {
  "io.nvidia.nemoclaw.hermes-state.managed": "true",
  "io.nvidia.nemoclaw.hermes-state.sandbox": "hermes",
  "io.nvidia.nemoclaw.hermes-state.schema": "1",
  "io.nvidia.nemoclaw.hermes-state.target": "/sandbox/.hermes",
};

const MANAGED_OPENCLAW_VOLUME_LABELS = {
  "io.nvidia.nemoclaw.openclaw-state.managed": "true",
  "io.nvidia.nemoclaw.openclaw-state.sandbox": "alpha",
  "io.nvidia.nemoclaw.openclaw-state.schema": "1",
  "io.nvidia.nemoclaw.openclaw-state.target": "/sandbox/.openclaw",
};

const MANAGED_VOLUME_LABELS = {
  hermes: MANAGED_HERMES_VOLUME_LABELS,
  openclaw: MANAGED_OPENCLAW_VOLUME_LABELS,
} as const;

describe("managed agent state volume provider cleanup authority (#13595)", () => {
  function removeThroughPodman(agent: "hermes" | "openclaw", labels: Record<string, string>) {
    const sandboxName = agent === "openclaw" ? "alpha" : "hermes";
    const volumeName = `nemoclaw-${agent}-state-v1-${sandboxName}`;
    const volume = createHermesStateVolumeDockerHarness();
    volume.runDocker([
      "create",
      ...Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
      volumeName,
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
    const logs: string[] = [];
    const warnings: string[] = [];
    const removed = removeManagedAgentStateVolumesForUninstall(
      [
        {
          agentName: agent,
          runtimeProviderId: "podman",
          sandboxName,
          workloadKind: "managed-image",
        },
      ],
      {
        env: {},
        error: vi.fn(),
        log: (message) => logs.push(message),
        runDocker,
        runtimeProviders: createRuntimeProviderBundleRegistry([["podman", provider]]),
        warn: (message) => warnings.push(message),
      },
    );
    return { capture, logs, removed, runDocker, sandboxName, volumeName, warnings };
  }

  it.each(["hermes", "openclaw"] as const)(
    "dispatches an owned %s volume through Podman cleanup authority",
    (agent) => {
      const result = removeThroughPodman(agent, MANAGED_VOLUME_LABELS[agent]);
      expect(result.removed).toBe(true);
      expect(result.capture).toHaveBeenCalledWith(["volume", "rm", result.volumeName], 30_000);
      expect(result.runDocker).not.toHaveBeenCalled();
      expect(result.logs).toContain(
        `Removed managed agent state volume for '${result.sandboxName}'.`,
      );
    },
  );

  it.each(["hermes", "openclaw"] as const)(
    "keeps a same-name %s volume without exact ownership labels",
    (agent) => {
      const [firstLabel, firstValue] = Object.entries(MANAGED_VOLUME_LABELS[agent])[0];
      const result = removeThroughPodman(agent, { [firstLabel]: firstValue });
      expect(result.removed).toBe(true);
      expect(result.capture).not.toHaveBeenCalledWith(["volume", "rm", result.volumeName], 30_000);
      expect(result.warnings.join("\n")).toContain(
        `Left managed state volume '${result.volumeName}' untouched`,
      );
    },
  );
});

it("removes the OpenClaw state volume of a legacy null-agent registry row (#13595)", async () => {
  const harness = await runManagedHermesVolumeUninstall(
    "owned",
    false,
    "absent",
    "openclaw",
    "default",
    null,
  );
  try {
    expect(harness.result.exitCode, harness.errors.join("\n")).toBe(0);
    expect(harness.volumePresent()).toBe(false);
    expect(harness.dockerCalls).toContainEqual(["volume", "rm", harness.volumeName]);
  } finally {
    harness.cleanup();
  }
});

it.each([
  ["explicit", "openclaw"],
  ["legacy null", null],
] as const)(
  "preserves uninstall state when %s-agent OpenClaw volume removal fails (#13595)",
  async (_label, registryAgent) => {
    const harness = await runManagedHermesVolumeUninstall(
      "remove-fails",
      true,
      "absent",
      "openclaw",
      "default",
      registryAgent,
    );
    try {
      expect(harness.result.exitCode).not.toBe(0);
      expect(harness.volumePresent()).toBe(true);
      expect(fs.existsSync(harness.registryFile)).toBe(true);
      expect(harness.errors.join("\n")).toContain(
        `Managed agent state volume '${harness.volumeName}' could not be removed.`,
      );
      expect(harness.errors).toContain("Preserved NemoClaw state so exact cleanup can be retried.");
    } finally {
      harness.cleanup();
    }
  },
);

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import type { PodmanBoundContainerEngine } from "../../adapters/podman";
import { createHermesStateVolumeDockerHarness } from "../../onboard/__test-helpers__/hermes-state-volume";
import { createDockerRuntimeProviderBundle } from "../../onboard/runtime-provider/docker";
import { createPodmanRuntimeProviderBundle } from "../../onboard/runtime-provider/podman";
import { createRuntimeProviderBundleRegistry } from "../../onboard/runtime-provider/registry";
import { removeManagedHermesStateVolumes } from "./hermes-uninstall-cleanup";
import { withSuccessfulPreUninstallBackup } from "../../../../test/support/uninstall-managed-gateway-test-support";

import {
  type RunResult,
  runUninstallPlanProduction as runUninstallPlanBase,
  type UninstallRunDeps,
  type UninstallRunOptions,
} from "./run-plan";

const MANAGED_HERMES_VOLUME_LABELS = {
  "io.nvidia.nemoclaw.hermes-state.managed": "true",
  "io.nvidia.nemoclaw.hermes-state.sandbox": "hermes",
  "io.nvidia.nemoclaw.hermes-state.schema": "1",
  "io.nvidia.nemoclaw.hermes-state.target": "/sandbox/.hermes",
};

function ok(stdout = ""): RunResult {
  return { status: 0, stdout, stderr: "" };
}

function runUninstallPlan(options: UninstallRunOptions, deps: UninstallRunDeps) {
  return runUninstallPlanBase(
    options,
    withSuccessfulPreUninstallBackup({
      resolveGatewayTeardownAuthority: ({ gatewayName, gatewayPort }) => ({
        gatewayName,
        gatewayPort,
        mode: "nemoclaw-managed",
        source: gatewayPort === 8080 ? "packaged-service" : "standalone",
        endpoint: null,
        stateDir: null,
        supervisor: null,
        requiredCapabilities: [],
      }),
      ...deps,
    }),
  );
}

async function runManagedHermesVolumeUninstall(
  mode: "foreign" | "owned" | "remove-fails",
  destroyUserData: boolean,
  containerMode: "absent" | "foreign" | "owned" = "absent",
) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-hermes-volume-"));
  const stateDir = path.join(home, ".nemoclaw");
  const registryFile = path.join(stateDir, "sandboxes.json");
  const volumeName = "nemoclaw-hermes-state-v1-hermes";
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    registryFile,
    JSON.stringify({
      defaultSandbox: "hermes",
      sandboxes: {
        hermes: {
          agent: "hermes",
          gatewayName: "nemoclaw",
          gatewayPort: 8080,
          name: "hermes",
          openshellDriver: "docker",
          workload: { kind: "managed-image" },
        },
      },
    }),
  );

  const dockerCalls: string[][] = [];
  const errors: string[] = [];
  const events: string[] = [];
  const logs: string[] = [];
  const containerId = "hermes-sandbox-container";
  let containerPresent = containerMode !== "absent";
  let volumePresent = true;
  const run = vi.fn((command: string, args: string[]) => {
    events.push(`${command} ${args.join(" ")}`);
    return command === "openshell" && args[0] === "gateway" && args[1] === "list"
      ? ok(JSON.stringify([{ name: "nemoclaw" }]))
      : ok();
  });
  const runDocker = vi.fn((args: string[]) => {
    dockerCalls.push(args);
    events.push(`docker ${args.join(" ")}`);
    switch (args.join(" ")) {
      case "ps -a --format {{.ID}} {{.Image}} {{.Names}}":
        switch (containerPresent ? containerMode : "absent") {
          case "owned":
            return ok(
              `${containerId} ghcr.io/nvidia/nemoclaw/hermes-sandbox:latest openshell-default--hermes-runtime-id\n`,
            );
          case "foreign":
            return ok(`${containerId} redis:7 foreign-service\n`);
          default:
            return ok();
        }
      case `rm -f ${containerId}`:
        containerPresent = false;
        return ok(`${containerId}\n`);
      case `volume inspect --format {{json .}} ${volumeName}`:
        return volumePresent
          ? ok(
              `${JSON.stringify({
                Labels:
                  mode === "foreign"
                    ? { "com.example.owner": "foreign" }
                    : MANAGED_HERMES_VOLUME_LABELS,
                Name: volumeName,
              })}\n`,
            )
          : { status: 1, stdout: "", stderr: `Error: no such volume: ${volumeName}` };
      case `volume rm ${volumeName}`:
        switch (containerPresent ? "attached" : mode) {
          case "attached":
          case "remove-fails":
            return { status: 1, stdout: "", stderr: "volume is still in use" };
          default:
            volumePresent = false;
            return ok(`${volumeName}\n`);
        }
      case "volume inspect openshell-cluster-nemoclaw":
        return { status: 1, stdout: "", stderr: "Error: no such volume" };
      default:
        return ok();
    }
  });

  const result = await runUninstallPlan(
    { assumeYes: true, deleteModels: false, destroyUserData, keepOpenShell: false },
    {
      commandExists: () => true,
      env: { HOME: home } as NodeJS.ProcessEnv,
      error: (line) => errors.push(line),
      existsSync: (target) => target.startsWith(home) && fs.existsSync(target),
      hasPortableRuntimeCleanup: () => false,
      isTty: false,
      kill: () => true,
      log: (line) => logs.push(line),
      rmSync: fs.rmSync,
      run,
      runDocker,
      runtimeProviders: createRuntimeProviderBundleRegistry([
        [
          "docker",
          createDockerRuntimeProviderBundle({
            captureHostCommand: (_command, args) => {
              const result = runDocker(args);
              return {
                status: result.status ?? 1,
                stdout: result.stdout,
                stderr: result.stderr,
              };
            },
          }),
        ],
      ]),
    },
  );

  return {
    cleanup: () => fs.rmSync(home, { force: true, recursive: true }),
    containerId,
    containerPresent: () => containerPresent,
    dockerCalls,
    errors,
    events,
    logs,
    registryFile,
    result,
    volumeName,
    volumePresent: () => volumePresent,
  };
}

describe("managed Hermes state volume uninstall", () => {
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
      removeManagedHermesStateVolumes(
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
    ["local uninstall", false],
    ["destructive uninstall", true],
  ])("removes an owned volume during %s", async (_label, destroyUserData) => {
    const harness = await runManagedHermesVolumeUninstall("owned", destroyUserData);
    try {
      expect(harness.result.exitCode, harness.errors.join("\n")).toBe(0);
      expect(harness.volumePresent()).toBe(false);
      expect(harness.dockerCalls).toContainEqual(["volume", "rm", harness.volumeName]);
      expect(harness.events.indexOf("openshell sandbox delete --all")).toBeLessThan(
        harness.events.indexOf(`docker volume rm ${harness.volumeName}`),
      );
      expect(harness.logs).toContain("Removed managed Hermes state volume for 'hermes'.");
    } finally {
      harness.cleanup();
    }
  });

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
        `Managed Hermes state volume '${harness.volumeName}' could not be removed.`,
      );
      expect(harness.errors).toContain("Preserved NemoClaw state so exact cleanup can be retried.");
    } finally {
      harness.cleanup();
    }
  });

  it("removes an owned stopped sandbox container before its Hermes state volume", async () => {
    const harness = await runManagedHermesVolumeUninstall("owned", true, "owned");
    try {
      expect(harness.result.exitCode, harness.errors.join("\n")).toBe(0);
      expect(harness.containerPresent()).toBe(false);
      expect(harness.volumePresent()).toBe(false);
      expect(harness.events.indexOf(`docker rm -f ${harness.containerId}`)).toBeLessThan(
        harness.events.indexOf(`docker volume rm ${harness.volumeName}`),
      );
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

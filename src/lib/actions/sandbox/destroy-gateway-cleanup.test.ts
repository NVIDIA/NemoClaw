// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { hasNoLiveSandboxes } from "../../domain/sandbox/destroy";
import { buildPodmanDriverGatewayEnv } from "../../onboard/compute/podman/gateway-env";
import {
  DOCKER_DRIVER_GATEWAY_CONFIG_NAME,
  MANAGED_GATEWAY_RUNTIME_BINDING_NAME,
} from "../../onboard/docker-driver-gateway-config";
import {
  collectLiveSandboxProbeSnapshot,
  type SandboxRuntimeContainerProbeAdapterRegistry,
  shouldCleanupGatewayAfterConfirmedFinalDestroy,
} from "./destroy-gateway-cleanup";

const runtimeBindingDirectories: string[] = [];

function createPersistedPodmanBinding(socketPath: string): string {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-destroy-podman-binding-"));
  runtimeBindingDirectories.push(stateDir);
  buildPodmanDriverGatewayEnv({
    gatewayPort: 8080,
    stateDir,
    podmanSocketPath: socketPath,
    supervisorImage: "ghcr.io/nvidia/openshell/supervisor@sha256:test",
  });
  return stateDir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of runtimeBindingDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("shouldCleanupGatewayAfterConfirmedFinalDestroy", () => {
  it("defers live probes until the local registry is empty", () => {
    const liveSandboxProbe = vi.fn(() => true);

    expect(
      shouldCleanupGatewayAfterConfirmedFinalDestroy(
        {
          deleteSucceededOrAlreadyGone: true,
          removedRegistryEntry: true,
        },
        {
          listSandboxes: () => ({ sandboxes: [{}] }),
          liveSandboxProbe,
        },
      ),
    ).toBe(false);
    expect(liveSandboxProbe).not.toHaveBeenCalled();
  });

  it("requires confirmed delete, registry removal, and no live sandboxes", () => {
    expect(
      shouldCleanupGatewayAfterConfirmedFinalDestroy(
        {
          deleteSucceededOrAlreadyGone: true,
          removedRegistryEntry: true,
        },
        {
          listSandboxes: () => ({ sandboxes: [] }),
          liveSandboxProbe: () => true,
        },
      ),
    ).toBe(true);

    expect(
      shouldCleanupGatewayAfterConfirmedFinalDestroy(
        {
          deleteSucceededOrAlreadyGone: true,
          removedRegistryEntry: true,
        },
        {
          listSandboxes: () => ({ sandboxes: [] }),
          liveSandboxProbe: () => false,
        },
      ),
    ).toBe(false);
  });

  it("preserves the gateway when a live sandbox appears after the empty-registry check", () => {
    const events: string[] = [];
    expect(
      shouldCleanupGatewayAfterConfirmedFinalDestroy(
        {
          deleteSucceededOrAlreadyGone: true,
          removedRegistryEntry: true,
        },
        {
          listSandboxes: () => {
            events.push("registry-empty");
            return { sandboxes: [] };
          },
          liveSandboxProbe: () => {
            events.push("live-sandbox-observed");
            // False means the host probe observed a sandbox during the TOCTOU window.
            return false;
          },
        },
      ),
    ).toBe(false);
    expect(events).toEqual(["registry-empty", "live-sandbox-observed"]);
  });

  it("collects OpenShell and legacy Docker live-sandbox snapshots in the action layer", () => {
    const captureOpenshell = vi.fn(() => ({
      status: 0,
      output:
        "NAME              CREATED              PHASE\nnpmtest           now                  Error\n",
    }));
    const dockerCapture = vi.fn(() => "openshell-npmtest-e487d1bd\n");

    const snapshot = collectLiveSandboxProbeSnapshot({
      captureOpenshell,
      dockerCapture,
      timeoutMs: 1_000,
    });

    expect(captureOpenshell).toHaveBeenCalledWith(["sandbox", "list"], {
      ignoreError: true,
      timeout: 1_000,
    });
    expect(dockerCapture).toHaveBeenCalledWith(
      ["ps", "--filter", "name=openshell-npmtest-", "--format", "{{.Names}}"],
      {
        timeout: 1_000,
      },
    );
    expect(snapshot.runtimeContainersBySandboxName.get("npmtest")).toEqual({ present: true });
    expect(hasNoLiveSandboxes(snapshot)).toBe(false);
  });

  it("records failed Docker probes as fail-closed snapshots", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const snapshot = collectLiveSandboxProbeSnapshot({
      captureOpenshell: () => ({
        status: 0,
        output:
          "NAME              CREATED              PHASE\nnpmtest           now                  Failed\n",
      }),
      dockerCapture: () => {
        throw new Error("docker unavailable");
      },
      timeoutMs: 1_000,
    });

    expect(hasNoLiveSandboxes(snapshot)).toBe(false);
    expect(snapshot.runtimeContainersBySandboxName.get("npmtest")).toEqual({
      present: false,
      probeFailed: true,
    });
    expect(warn).toHaveBeenCalledWith(
      "Docker container probe failed for sandbox 'npmtest'; preserving shared gateway: Error: docker unavailable",
    );
  });

  it("uses the exact Podman socket and OpenShell labels without touching Docker", () => {
    const socketPath = "/run/user/1000/podman/podman.sock";
    const stateDir = createPersistedPodmanBinding(socketPath);
    const dockerCapture = vi.fn(() => {
      throw new Error("Docker must not be invoked for Podman");
    });
    const captureHostCommand = vi.fn(() => ({
      status: 0,
      stdout: '[{"Id":"podman-container"}]\n',
      stderr: "",
    }));

    const snapshot = collectLiveSandboxProbeSnapshot({
      captureOpenshell: () => ({
        status: 0,
        output:
          "NAME              CREATED              PHASE\nnpmtest           now                  Error\n",
      }),
      captureHostCommand,
      dockerCapture,
      environment: {
        OPENSHELL_PODMAN_SOCKET: socketPath,
      },
      gatewayStateDir: stateDir,
      openshellDriver: "podman",
      timeoutMs: 1_000,
    });

    expect(dockerCapture).not.toHaveBeenCalled();
    expect(captureHostCommand).toHaveBeenCalledWith(
      "podman",
      [
        "--url",
        "unix:///run/user/1000/podman/podman.sock",
        "ps",
        "--all",
        "--filter",
        "label=openshell.ai/managed-by=openshell",
        "--filter",
        "label=openshell.ai/sandbox-name=npmtest",
        "--format",
        "json",
      ],
      1_000,
    );
    expect(snapshot.runtimeContainersBySandboxName.get("npmtest")).toEqual({ present: true });
    expect(hasNoLiveSandboxes(snapshot)).toBe(false);
  });

  it("recovers the exact Podman socket from the target gateway binding in a fresh shell", () => {
    const socketPath = "/run/user/1000/podman/persisted.sock";
    const stateDir = createPersistedPodmanBinding(socketPath);
    const dockerCapture = vi.fn(() => {
      throw new Error("Docker must not be invoked for persisted Podman cleanup");
    });
    const captureHostCommand = vi.fn(() => ({
      status: 0,
      stdout: "[]\n",
      stderr: "",
    }));

    const snapshot = collectLiveSandboxProbeSnapshot({
      captureOpenshell: () => ({
        status: 0,
        output:
          "NAME              CREATED              PHASE\nnpmtest           now                  Error\n",
      }),
      captureHostCommand,
      dockerCapture,
      environment: {},
      gatewayStateDir: stateDir,
      openshellDriver: "podman",
      timeoutMs: 1_000,
    });

    expect(dockerCapture).not.toHaveBeenCalled();
    expect(captureHostCommand).toHaveBeenCalledWith(
      "podman",
      [
        "--url",
        `unix://${socketPath}`,
        "ps",
        "--all",
        "--filter",
        "label=openshell.ai/managed-by=openshell",
        "--filter",
        "label=openshell.ai/sandbox-name=npmtest",
        "--format",
        "json",
      ],
      1_000,
    );
    expect(hasNoLiveSandboxes(snapshot)).toBe(true);
  });

  it.each([
    [
      "driver mismatch",
      (stateDir: string) => {
        const bindingPath = path.join(stateDir, MANAGED_GATEWAY_RUNTIME_BINDING_NAME);
        const binding = JSON.parse(fs.readFileSync(bindingPath, "utf8")) as Record<string, unknown>;
        binding.driverName = "docker";
        fs.writeFileSync(bindingPath, `${JSON.stringify(binding, null, 2)}\n`, { mode: 0o600 });
      },
      /declares driver 'docker', not 'podman'/,
    ],
    [
      "config tampering",
      (stateDir: string) => {
        fs.appendFileSync(
          path.join(stateDir, DOCKER_DRIVER_GATEWAY_CONFIG_NAME),
          "\n# injected drift\n",
        );
      },
      /does not match its gateway configuration/,
    ],
  ] as const)("fails closed on persisted Podman binding %s without touching Docker", (_case, tamper, expected) => {
    const stateDir = createPersistedPodmanBinding("/run/user/1000/podman/persisted.sock");
    tamper(stateDir);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const dockerCapture = vi.fn(() => {
      throw new Error("Docker must not be the binding recovery fallback");
    });
    const captureHostCommand = vi.fn(() => {
      throw new Error("Podman must not run with untrusted binding evidence");
    });

    const snapshot = collectLiveSandboxProbeSnapshot({
      captureOpenshell: () => ({
        status: 0,
        output:
          "NAME              CREATED              PHASE\nnpmtest           now                  Failed\n",
      }),
      captureHostCommand,
      dockerCapture,
      environment: {},
      gatewayStateDir: stateDir,
      openshellDriver: "podman",
      timeoutMs: 1_000,
    });

    expect(dockerCapture).not.toHaveBeenCalled();
    expect(captureHostCommand).not.toHaveBeenCalled();
    expect(hasNoLiveSandboxes(snapshot)).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(expected));
  });

  it("accepts an injected MXC container probe without inheriting Docker or Podman behavior", () => {
    const createProbe = vi.fn(() => (sandboxName: string) => ({
      present: sandboxName === "npmtest",
    }));
    const runtimeContainerProbeAdapters = {
      mxc: {
        displayName: "MXC",
        driverName: "mxc",
        createProbe,
      },
    } satisfies SandboxRuntimeContainerProbeAdapterRegistry;
    const dockerCapture = vi.fn(() => {
      throw new Error("MXC must not inherit Docker probing");
    });
    const captureHostCommand = vi.fn(() => {
      throw new Error("MXC must not inherit Podman probing");
    });

    const snapshot = collectLiveSandboxProbeSnapshot({
      captureOpenshell: () => ({
        status: 0,
        output:
          "NAME              CREATED              PHASE\nnpmtest           now                  Error\n",
      }),
      captureHostCommand,
      dockerCapture,
      openshellDriver: "mxc",
      runtimeContainerProbeAdapters,
      timeoutMs: 1_000,
    });

    expect(createProbe).toHaveBeenCalledOnce();
    expect(dockerCapture).not.toHaveBeenCalled();
    expect(captureHostCommand).not.toHaveBeenCalled();
    expect(snapshot.runtimeContainersBySandboxName.get("npmtest")).toEqual({ present: true });
    expect(hasNoLiveSandboxes(snapshot)).toBe(false);
  });

  it("does not inherit Docker probing for an unregistered future runtime", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const dockerCapture = vi.fn(() => {
      throw new Error("Docker must not be the future-runtime fallback");
    });
    const captureHostCommand = vi.fn(() => {
      throw new Error("No runtime adapter is registered");
    });

    const snapshot = collectLiveSandboxProbeSnapshot({
      captureOpenshell: () => ({
        status: 0,
        output:
          "NAME              CREATED              PHASE\nnpmtest           now                  Failed\n",
      }),
      captureHostCommand,
      dockerCapture,
      openshellDriver: "mxc",
      timeoutMs: 1_000,
    });

    expect(dockerCapture).not.toHaveBeenCalled();
    expect(captureHostCommand).not.toHaveBeenCalled();
    expect(hasNoLiveSandboxes(snapshot)).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      "mxc container probe failed for sandbox 'npmtest'; preserving shared gateway: no runtime container probe is registered",
    );
  });
});

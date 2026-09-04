// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import {
  ensureConfiguredRuntimeProviderAvailable,
  RuntimeProviderPrerequisite,
} from "../fixtures/runtime-provider.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

function successfulProbe(): ShellProbeResult {
  return {
    command: [],
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "ready",
    stderr: "",
    artifacts: { stdout: "", stderr: "", result: "" },
  };
}

function successfulProbeWithStdout(stdout: string): ShellProbeResult {
  return { ...successfulProbe(), stdout };
}

describe("configured E2E runtime provider fixture", () => {
  it("preserves native Podman runtime authority for CLI child processes", () => {
    const env = buildAvailabilityProbeEnv({
      HOME: "/home/runner",
      PATH: "/usr/bin",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1001/bus",
      NEMOCLAW_E2E_MANAGED_IMAGE_REVISION: "a".repeat(40),
      NEMOCLAW_GATEWAY_RUNTIME: "podman",
      OPENSHELL_PODMAN_SOCKET: "/run/user/1001/podman/podman.sock",
      XDG_RUNTIME_DIR: "/run/user/1001",
    });

    expect(env).toMatchObject({
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1001/bus",
      NEMOCLAW_E2E_MANAGED_IMAGE_REVISION: "a".repeat(40),
      NEMOCLAW_GATEWAY_RUNTIME: "podman",
      OPENSHELL_PODMAN_SOCKET: "/run/user/1001/podman/podman.sock",
      XDG_RUNTIME_DIR: "/run/user/1001",
    });
  });

  it("probes native Podman through the workflow-owned socket authority", async () => {
    const command = vi.fn<HostCliClient["command"]>().mockResolvedValue(successfulProbe());
    const environment = {
      HOME: "/home/runner",
      PATH: "/reviewed/bin:/usr/bin",
      NEMOCLAW_GATEWAY_RUNTIME: "podman",
      OPENSHELL_PODMAN_SOCKET: "/run/user/1001/podman/podman.sock",
      XDG_RUNTIME_DIR: "/run/user/1001",
    };

    await ensureConfiguredRuntimeProviderAvailable({
      artifactName: "provider-info",
      environment,
      host: { command } as unknown as HostCliClient,
      scenarioLabel: "Hermes GPU response validation",
      skip: (reason) => {
        throw new Error(reason);
      },
    });

    expect(command).toHaveBeenCalledWith(
      "podman",
      ["--url", "unix:///run/user/1001/podman/podman.sock", "info"],
      expect.objectContaining({
        artifactName: "provider-info",
        env: expect.objectContaining({
          NEMOCLAW_GATEWAY_RUNTIME: "podman",
          OPENSHELL_PODMAN_SOCKET: "/run/user/1001/podman/podman.sock",
          XDG_RUNTIME_DIR: "/run/user/1001",
        }),
        timeoutMs: 30_000,
      }),
    );
    expect(command.mock.calls[0]?.[2]?.env?.PATH).toContain(environment.PATH);
  });

  it("keeps the portable profile on its existing Docker compatibility probe", async () => {
    const command = vi.fn<HostCliClient["command"]>().mockResolvedValue(successfulProbe());

    await ensureConfiguredRuntimeProviderAvailable({
      artifactName: "portable-provider-info",
      environment: {
        HOME: "/home/runner",
        PATH: "/usr/bin",
        NEMOCLAW_EXPERIMENTAL_PROFILE: "portable",
        NEMOCLAW_GATEWAY_RUNTIME: "podman",
      },
      host: { command } as unknown as HostCliClient,
      scenarioLabel: "portable-profile",
      skip: (reason) => {
        throw new Error(reason);
      },
    });

    expect(command).toHaveBeenCalledWith(
      "docker",
      ["info"],
      expect.objectContaining({ artifactName: "portable-provider-info" }),
    );
  });

  it("executes fixture-owned root probes through the selected Podman resource", async () => {
    const command = vi
      .fn<HostCliClient["command"]>()
      .mockResolvedValueOnce(successfulProbeWithStdout(`${"a".repeat(64)}\n`))
      .mockResolvedValueOnce(successfulProbe());
    const runtime = new RuntimeProviderPrerequisite(
      { command } as unknown as HostCliClient,
      (reason) => {
        throw new Error(reason);
      },
      {
        HOME: "/home/runner",
        PATH: "/usr/bin",
        NEMOCLAW_GATEWAY_RUNTIME: "podman",
        OPENSHELL_PODMAN_SOCKET: "/run/user/1001/podman/podman.sock",
      },
    );

    await runtime.execSandboxAsRoot("alpha", ["id", "-u"], {
      artifactName: "privileged-id",
      sanitizeEnvironment: true,
    });

    expect(command).toHaveBeenNthCalledWith(
      1,
      "podman",
      [
        "--url",
        "unix:///run/user/1001/podman/podman.sock",
        "container",
        "ps",
        "--all",
        "--no-trunc",
        "--filter",
        "label=openshell.ai/sandbox-name=alpha",
        "--format",
        "{{.ID}}",
      ],
      expect.objectContaining({ artifactName: "privileged-id-resource" }),
    );
    expect(command).toHaveBeenNthCalledWith(
      2,
      "podman",
      expect.arrayContaining([
        "--url",
        "unix:///run/user/1001/podman/podman.sock",
        "container",
        "exec",
        "--user",
        "root",
        "a".repeat(64),
        "id",
        "-u",
      ]),
      expect.objectContaining({ artifactName: "privileged-id" }),
    );
  });
});

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { DockerSpawnSyncResult } from "../../adapters/docker/exec";
import {
  assertLegacyGatewayHostAliasSupportWithDeps,
  HostAliasesCommandError,
  probeLegacyGatewayContainerWithDeps,
  validateSandboxHostAliasAddOptions,
  validateSandboxHostAliasRemoveOptions,
} from "./host-aliases";

function dockerPsResult(overrides: Partial<DockerSpawnSyncResult>): DockerSpawnSyncResult {
  return {
    status: 0,
    signal: null,
    output: [],
    pid: 123,
    stdout: "",
    stderr: "",
    ...overrides,
  } as unknown as DockerSpawnSyncResult;
}

function dockerPsError(code: string, message: string): DockerSpawnSyncResult {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return dockerPsResult({ error });
}

function expectHostAliasError(action: () => void): HostAliasesCommandError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(HostAliasesCommandError);
    return error as HostAliasesCommandError;
  }
  throw new Error("expected HostAliasesCommandError");
}

describe("host alias legacy gateway support checks", () => {
  for (const driver of ["docker", "vm"] as const) {
    it(`rejects ${driver} driver sandboxes before probing Docker`, () => {
      const probeLegacyGatewayContainer = vi.fn(() => ({ state: "present" as const }));

      const error = expectHostAliasError(() =>
        assertLegacyGatewayHostAliasSupportWithDeps("alpha", {
          getSandbox: () => ({ openshellDriver: driver }),
          probeLegacyGatewayContainer,
        }),
      );

      expect(error.message).toContain(
        `Host aliases are not supported on the '${driver}' driver sandbox 'alpha'.`,
      );
      expect(error.message).toContain(`which the ${driver} driver does not run`);
      expect(probeLegacyGatewayContainer).not.toHaveBeenCalled();
    });
  }

  it("reports a missing legacy gateway distinctly from Docker probe failures", () => {
    const error = expectHostAliasError(() =>
      assertLegacyGatewayHostAliasSupportWithDeps("alpha", {
        getSandbox: () => ({}),
        probeLegacyGatewayContainer: () => ({ state: "absent" }),
      }),
    );

    expect(error.message).toContain(
      "Host aliases require the legacy OpenShell gateway container 'openshell-cluster-nemoclaw' to be running.",
    );
    expect(error.message).toContain("sandbox 'alpha', driver: unspecified");
    expect(error.message).not.toContain("Docker probe failed");
  });

  it("surfaces Docker probe failures without calling them missing gateways", () => {
    const error = expectHostAliasError(() =>
      assertLegacyGatewayHostAliasSupportWithDeps("alpha", {
        getSandbox: () => ({}),
        probeLegacyGatewayContainer: () => ({
          state: "unknown",
          reason: "Cannot connect to the Docker daemon",
        }),
      }),
    );

    expect(error.message).toContain(
      "Could not verify the legacy OpenShell gateway container 'openshell-cluster-nemoclaw'.",
    );
    expect(error.message).toContain("Docker probe failed: Cannot connect to the Docker daemon");
    expect(error.message).toContain("docker info");
    expect(error.message).not.toContain("Host aliases require the legacy");
  });
});

describe("legacy gateway Docker probe classification", () => {
  it("classifies exact gateway container matches as present", () => {
    const result = probeLegacyGatewayContainerWithDeps(() =>
      dockerPsResult({ stdout: "openshell-cluster-nemoclaw\nother-container\n" }),
    );

    expect(result).toEqual({ state: "present" });
  });

  it("classifies missing exact gateway container matches as absent", () => {
    const result = probeLegacyGatewayContainerWithDeps(() =>
      dockerPsResult({ stdout: "openshell-cluster-nemoclaw-old\n" }),
    );

    expect(result).toEqual({ state: "absent" });
  });

  it("classifies docker ps launch failures as unknown", () => {
    const result = probeLegacyGatewayContainerWithDeps(() =>
      dockerPsError("ENOENT", "spawn docker ENOENT"),
    );

    expect(result).toEqual({
      state: "unknown",
      reason: "docker ps could not launch: spawn docker ENOENT",
    });
  });

  it("classifies docker ps timeouts as unknown timeouts", () => {
    const result = probeLegacyGatewayContainerWithDeps(() =>
      dockerPsError("ETIMEDOUT", "spawn docker ETIMEDOUT"),
    );

    expect(result).toEqual({ state: "unknown", reason: "docker ps timed out" });
  });

  it("classifies nonzero docker ps exits as unknown probe failures", () => {
    const result = probeLegacyGatewayContainerWithDeps(() =>
      dockerPsResult({
        status: 1,
        stderr:
          "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n",
      }),
    );

    expect(result).toEqual({
      state: "unknown",
      reason:
        "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
    });
  });
});

describe("host alias option validation", () => {
  it("normalizes valid host alias add and remove options", () => {
    expect(
      validateSandboxHostAliasAddOptions({
        hostname: "Search.Example",
        ip: "192.168.1.105",
      }),
    ).toEqual({ hostname: "search.example", ip: "192.168.1.105" });
    expect(validateSandboxHostAliasRemoveOptions({ hostname: "Search.Example" })).toEqual({
      hostname: "search.example",
    });
  });

  it("rejects invalid add options before gateway probing", () => {
    expect(expectHostAliasError(() => validateSandboxHostAliasAddOptions({})).message).toContain(
      "hosts-add",
    );
    expect(
      expectHostAliasError(() =>
        validateSandboxHostAliasAddOptions({ hostname: "invalid_name!!", ip: "1.2.3.4" }),
      ).message,
    ).toContain("Invalid hostname 'invalid_name!!'");
    expect(
      expectHostAliasError(() =>
        validateSandboxHostAliasAddOptions({ hostname: "search.example", ip: "not-an-ip" }),
      ).message,
    ).toContain("Invalid IP address 'not-an-ip'");
  });

  it("rejects invalid remove options before gateway probing", () => {
    expect(expectHostAliasError(() => validateSandboxHostAliasRemoveOptions({})).message).toContain(
      "hosts-remove",
    );
    expect(
      expectHostAliasError(() =>
        validateSandboxHostAliasRemoveOptions({ hostname: "invalid_name!!" }),
      ).message,
    ).toContain("Invalid hostname 'invalid_name!!'");
  });
});

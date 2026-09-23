// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import * as docker from "../../../adapters/docker/run";
import { fingerprintOpenShellSandboxId } from "../../../adapters/openshell/sandbox-identity";
import { createSdkOpenShellSandboxStateLifecycle } from "../../../adapters/openshell/sandbox-lifecycle-sdk";
import type { OpenShellSandboxError } from "../../../adapters/openshell/sandbox-observer";
import type { RuntimeProviderLifecycleInput } from "../../../onboard/runtime-provider/contract";
import { mutateStandardSandboxLifecycle } from "./standard-lifecycle";

function input(driver = "docker"): RuntimeProviderLifecycleInput {
  return {
    sandboxName: "alpha",
    sandbox: {
      name: "alpha",
      openshellDriver: driver,
      lifecycleLiveIdentityFingerprint: fingerprintOpenShellSandboxId("sandbox-alpha")!,
      stopped: true,
    },
    gatewayName: "owning-gateway",
    environment: {},
    log: vi.fn(),
  };
}

describe("standard OpenShell lifecycle failure guidance", () => {
  it.each(["connect", "observe", "submit", "settle"] as const)(
    "preserves uncertain sandbox state when start fails during %s (#11715)",
    async (stage) => {
      const failure = () => {
        throw new Error("connection refused");
      };
      const get = vi.fn(async () => ({ id: "sandbox-alpha", phase: "Stopped" }));
      const start = vi.fn(async () => ({ sandbox: { metadata: { id: "sandbox-alpha" } } }));
      const waitReady = vi.fn(async () => ({ id: "sandbox-alpha", phase: "Ready" }));
      const connect = vi.fn(async () => ({
        sandbox: { get, waitReady },
        raw: { startSandbox: start, stopSandbox: vi.fn() },
      }));
      const operations = { connect, observe: get, submit: start, settle: waitReady };
      operations[stage].mockImplementation(failure);
      const engine = vi.spyOn(docker, "dockerRun").mockImplementation(() => {
        throw new Error("Lifecycle diagnostics must not invoke Docker");
      });
      const request = input();
      const before = structuredClone(request.sandbox);
      const result = await mutateStandardSandboxLifecycle("start", request, {
        openShellLifecycle: createSdkOpenShellSandboxStateLifecycle({ connect }),
      });

      expect(result.exitCode).toBe(1);
      expect(result.message).toContain("OpenShell could not start sandbox 'alpha'");
      expect(result.message).toContain("Sandbox state is unverified");
      expect(result.message).toContain(
        "Preserve the sandbox; do not rebuild, destroy, or re-onboard",
      );
      expect(result.message).toContain("Run `docker info` on the owning gateway's host");
      expect(result.message).toContain("permission, context, or TLS");
      expect(result.message).toContain("owning-gateway");
      expect(result.message).toContain("alpha status` before retrying");
      expect(result.message).not.toContain("docker_unreachable");
      expect(result.message).not.toContain("Start the Docker daemon");
      expect(result.message).not.toContain("alpha rebuild");
      expect(request.sandbox).toEqual(before);
      expect(request.log).not.toHaveBeenCalled();
      expect(connect).toHaveBeenCalledOnce();
      expect(start).toHaveBeenCalledTimes(stage === "connect" || stage === "observe" ? 0 : 1);
      expect(engine).not.toHaveBeenCalled();
    },
  );

  it.each(["start", "stop"] as const)(
    "requires state verification before retrying a timed-out %s",
    async (action) => {
      const mutation = vi.fn(async () => ({
        kind: "failed" as const,
        error: { kind: "timeout" as const, message: "OpenShell timed out." },
      }));
      const result = await mutateStandardSandboxLifecycle(action, input(), {
        openShellLifecycle: { startSandbox: mutation, stopSandbox: mutation },
      });
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain("OpenShell timed out.");
      expect(result.message).toContain("Sandbox state is unverified");
      expect(result.message).toContain("alpha status` before retrying");
      expect(mutation).toHaveBeenCalledOnce();
    },
  );

  it.each(["podman", "vm", " VM "])(
    "does not attribute a %s gateway failure to Docker",
    async (driver) => {
      const mutation = vi.fn(async () => ({
        kind: "failed" as const,
        error: {
          kind: "transport" as const,
          reason: "unreachable" as const,
          message: "Gateway unreachable.",
        },
      }));
      const result = await mutateStandardSandboxLifecycle("start", input(driver), {
        openShellLifecycle: { startSandbox: mutation, stopSandbox: mutation },
      });
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain("Gateway unreachable.");
      expect(result.message).toContain("Preserve the sandbox");
      expect(result.message).not.toContain("Docker");
      expect(result.message).not.toContain("docker");
    },
  );

  it.each([undefined, "", " DOCKER "])(
    "keeps Docker guidance for legacy or Docker driver %s",
    async (driver) => {
      const mutation = vi.fn(async () => ({
        kind: "failed" as const,
        error: { kind: "timeout" as const, message: "OpenShell timed out." },
      }));
      const request = input();
      request.sandbox.openshellDriver = driver;

      const result = await mutateStandardSandboxLifecycle("start", request, {
        openShellLifecycle: { startSandbox: mutation, stopSandbox: mutation },
      });

      expect(result.exitCode).toBe(1);
      expect(result.message).toContain("OpenShell timed out.");
      expect(result.message).toContain("Run `docker info` on the owning gateway's host");
      expect(mutation).toHaveBeenCalledOnce();
    },
  );

  it.each<OpenShellSandboxError>([
    { kind: "authentication", message: "OpenShell denied access." },
    { kind: "schema", message: "Invalid sandbox request." },
    {
      kind: "transport",
      reason: "identity_mismatch",
      message: "OpenShell sandbox identity changed.",
    },
    {
      kind: "transport",
      reason: "endpoint_override",
      message: "Endpoint override is not allowed.",
    },
  ])("preserves the specific $kind failure without Docker recovery advice", async (error) => {
    const mutation = vi.fn(async () => ({ kind: "failed" as const, error }));
    const result = await mutateStandardSandboxLifecycle("start", input(), {
      openShellLifecycle: { startSandbox: mutation, stopSandbox: mutation },
    });
    expect(result).toEqual({
      exitCode: 1,
      message: `  OpenShell could not start sandbox 'alpha': ${error.message}`,
    });
    expect(mutation).toHaveBeenCalledOnce();
  });
});

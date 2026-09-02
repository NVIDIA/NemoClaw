// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const requireDist = createRequire(import.meta.url);
const modulePath = "./doctor-system-checks.js";

describe("doctor system checks", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete requireDist.cache[requireDist.resolve(modulePath)];
  });

  it("validates Docker mappings against the sandbox gateway port exactly", () => {
    const hostCommand = requireDist("./doctor-host-command.js");
    const captureSpy = vi
      .spyOn(hostCommand, "captureHostCommand")
      .mockReturnValueOnce({ status: 0, stdout: "true\thealthy\timage", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "0.0.0.0:19080", stderr: "" });
    const { dockerInspectGateway } = requireDist(modulePath);

    expect(dockerInspectGateway("gateway", {}, 19080)[1]).toMatchObject({ status: "ok" });

    captureSpy
      .mockReturnValueOnce({ status: 0, stdout: "true\thealthy\timage", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "0.0.0.0:190800", stderr: "" });
    expect(dockerInspectGateway("gateway", {}, 19080)[1]).toMatchObject({
      status: "warn",
      hint: "expected host port 19080 for this sandbox gateway",
    });
  });

  it("probes a loopback Ollama route with direct curl", () => {
    const runCaptureImpl = vi.fn((_command: readonly string[]) =>
      JSON.stringify({ models: [{ name: "qwen3.6:35b" }] }),
    );
    const prepareDockerEnvironment = vi.fn();
    const { ollamaDoctorCheck } = requireDist(modulePath);

    expect(
      ollamaDoctorCheck("ollama-local", {
        getOllamaHost: () => "127.0.0.1",
        runCaptureImpl,
        prepareDockerEnvironment,
      }),
    ).toMatchObject({
      status: "ok",
      detail: "reachable at http://127.0.0.1:11434/api/tags (1 model(s))",
    });
    expect(runCaptureImpl.mock.calls[0]?.[0]?.[0]).toBe("curl");
    expect(runCaptureImpl.mock.calls[0]?.[0]).toContain("http://127.0.0.1:11434/api/tags");
    expect(prepareDockerEnvironment).not.toHaveBeenCalled();
  });

  it("probes a persisted Windows Ollama route through credential-free Docker", () => {
    const cleanup = vi.fn(() => ({ ok: true as const }));
    const prepareDockerEnvironment = vi.fn(() => ({
      env: { DOCKER_CONFIG: "/tmp/credential-free-docker" },
      isolatedCredentialConfig: true,
      cleanup,
    }));
    const runCaptureImpl = vi.fn(
      (command: readonly string[], options?: { env?: NodeJS.ProcessEnv }) =>
        command[0] === "docker" && options?.env?.DOCKER_CONFIG === "/tmp/credential-free-docker"
          ? JSON.stringify({ models: [] })
          : "",
    );
    const { ollamaDoctorCheck } = requireDist(modulePath);

    expect(
      ollamaDoctorCheck("ollama-local", {
        getOllamaHost: () => "host.docker.internal",
        runCaptureImpl,
        prepareDockerEnvironment,
      }),
    ).toMatchObject({
      status: "ok",
      detail: "reachable at http://host.docker.internal:11434/api/tags (0 model(s))",
    });
    expect(runCaptureImpl.mock.calls[0]?.[0]?.[0]).toBe("docker");
    expect(runCaptureImpl.mock.calls[0]?.[0]).toContain(
      "http://host.docker.internal:11434/api/tags",
    );
    expect(prepareDockerEnvironment).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
  });
});

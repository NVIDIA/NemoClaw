// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as localModelDocker from "../adapters/docker/run";
import { VLLM_PORT } from "../core/ports";
import { probeLocalProviderHealth } from "./local";

function inspectBearerlessVllmBindings(bindings: { HostIp: string; HostPort: string }[] | null) {
  const responses = new Map([
    [
      "container inspect nemoclaw-vllm",
      bindings
        ? JSON.stringify([
            {
              Id: "a".repeat(64),
              Name: "/nemoclaw-vllm",
              State: { Running: true },
              Config: { Labels: { "com.nvidia.nemoclaw.managed-vllm": "true" } },
              NetworkSettings: { Ports: { "8000/tcp": bindings } },
            },
          ])
        : "",
    ],
    [
      "network inspect --format {{json .IPAM.Config}} openshell-docker",
      JSON.stringify([{ Gateway: "172.18.0.1" }]),
    ],
  ]);
  vi.spyOn(localModelDocker, "dockerCapture").mockImplementation(
    (argv) => responses.get(argv.join(" ")) ?? "",
  );
  vi.spyOn(localModelDocker, "dockerRun").mockReturnValue({
    status: bindings ? 0 : 1,
    stdout: responses.get("container inspect nemoclaw-vllm") ?? "",
    stderr: bindings ? "" : "Error: No such object: nemoclaw-vllm",
  } as ReturnType<typeof localModelDocker.dockerRun>);
}

describe("recorded bearerless vLLM health ports", () => {
  beforeEach(() => {
    vi.stubEnv("DOCKER_CONTEXT", "default");
    vi.stubEnv("DOCKER_HOST", "");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each([false, true])(
    "probes the recorded bearerless vLLM port with an owned container: %s",
    (owned) => {
      const recordedPort = VLLM_PORT === 18080 ? 18081 : 18080;
      inspectBearerlessVllmBindings(
        owned
          ? [
              { HostIp: "127.0.0.1", HostPort: String(recordedPort) },
              { HostIp: "172.18.0.1", HostPort: String(recordedPort) },
            ]
          : null,
      );
      const probedEndpoints: string[] = [];
      const result = probeLocalProviderHealth("vllm-local", {
        recordedEndpointUrl: `http://host.openshell.internal:${recordedPort}/v1`,
        runCurlProbeImpl: (argv) => {
          probedEndpoints.push(argv.at(-1) ?? "");
          return {
            ok: true,
            httpStatus: 200,
            curlStatus: 0,
            body: '{"data":[]}',
            stderr: "",
            message: "HTTP 200",
          };
        },
      });

      expect(result?.ok).toBe(true);
      expect(result?.endpoint).toBe(`http://127.0.0.1:${recordedPort}/v1/models`);
      expect(probedEndpoints).toEqual([`http://127.0.0.1:${recordedPort}/v1/models`]);
    },
  );

  it.each(["0.0.0.0", "::"])(
    "refuses a recorded bearerless vLLM route with a public %s binding before probing",
    (host) => {
      inspectBearerlessVllmBindings([{ HostIp: host, HostPort: "18080" }]);
      const probe = vi.fn();
      const result = probeLocalProviderHealth("vllm-local", {
        recordedEndpointUrl: "http://host.openshell.internal:18080/v1",
        runCurlProbeImpl: probe,
      });

      expect(result?.ok).toBe(false);
      expect(result?.detail).toContain("unsafe host bindings");
      expect(probe).not.toHaveBeenCalled();
    },
  );

  it.each([
    { endpoint: null, reason: "no recorded route" },
    { endpoint: "https://inference.local/v1", reason: "an in-sandbox route" },
    { endpoint: "http://host.openshell.internal/v1", reason: "no port" },
    { endpoint: "http://host.openshell.internal:80/v1", reason: "a privileged port" },
    { endpoint: "http://example.com:46145/v1", reason: "a foreign host" },
    { endpoint: "http://user:secret@host.openshell.internal:46145/v1", reason: "userinfo" },
    { endpoint: "http://host.openshell.internal:46145/v1?probe=1", reason: "a query string" },
    { endpoint: "http://host.openshell.internal:46145/v1#probe", reason: "a fragment" },
    { endpoint: "http://host.openshell.internal:46145/v1/chat", reason: "a non-route path" },
    { endpoint: "http://host.openshell.internal:46145/v1/", reason: "a non-canonical path" },
    { endpoint: "not a url", reason: "a malformed URL" },
  ])(
    "keeps the configured local vLLM port when the recorded route has $reason",
    ({ endpoint: recordedEndpointUrl }) => {
      inspectBearerlessVllmBindings([
        { HostIp: "127.0.0.1", HostPort: String(VLLM_PORT) },
        { HostIp: "172.18.0.1", HostPort: String(VLLM_PORT) },
      ]);
      const result = probeLocalProviderHealth("vllm-local", {
        recordedEndpointUrl,
        runCurlProbeImpl: () => ({
          ok: false,
          httpStatus: 0,
          curlStatus: 7,
          body: "",
          stderr: "Failed to connect",
          message: "curl failed (exit 7)",
        }),
      });

      expect(result?.endpoint).toBe(`http://127.0.0.1:${VLLM_PORT}/v1/models`);
    },
  );
});

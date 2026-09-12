// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

const PUBLISHED_HOST_PORT = 46_145;
const AMBIENT_CONTEXT = "remote-builder";

vi.mock("../adapters/docker/container", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../adapters/docker/container")>()),
  dockerPort: vi.fn(() => `0.0.0.0:${PUBLISHED_HOST_PORT}\n[::]:${PUBLISHED_HOST_PORT}\n`),
}));

import { dockerPort } from "../adapters/docker/container";
import { probeLocalProviderHealth } from "./local";

describe("managed vLLM status probe port resolution", () => {
  it("probes the published host port of the managed container, not the default", () => {
    const probedArgv: string[] = [];

    probeLocalProviderHealth("vllm-local", {
      model: "served-model",
      // An unauthenticated managed container yields no recovered binding, which
      // is the state reported in #11374 for a custom NEMOCLAW_VLLM_PORT run.
      getManagedVllmBaseUrlImpl: () => null,
      loadVllmApiKeyImpl: () => null,
      runCurlProbeImpl: (argv) => {
        probedArgv.push(...argv);
        return {
          ok: true,
          httpStatus: 200,
          curlStatus: 0,
          body: '{"data":[{"id":"served-model"}]}',
          stderr: "",
          message: "HTTP 200",
        };
      },
    });

    const endpoint = probedArgv.find((arg) => arg.includes("/v1/models")) ?? "";
    expect(endpoint).toContain(`:${PUBLISHED_HOST_PORT}`);
  });
  it("finds the container only through the ambient Docker selection", () => {
    // The local-daemon selection pins DOCKER_CONTEXT to "default"; the ambient
    // selection carries whatever this process has configured. An ordinary
    // managed profile is launched with the ambient one.
    vi.stubEnv("DOCKER_CONTEXT", AMBIENT_CONTEXT);
    const selectorsProbed: (string | undefined)[] = [];
    vi.mocked(dockerPort).mockImplementation((_name, _port, opts) => {
      const selector = opts?.env?.DOCKER_CONTEXT;
      selectorsProbed.push(selector);
      return selector === AMBIENT_CONTEXT ? `0.0.0.0:${PUBLISHED_HOST_PORT}\n` : "";
    });
    const probedArgv: string[] = [];

    probeLocalProviderHealth("vllm-local", {
      model: "served-model",
      getManagedVllmBaseUrlImpl: () => null,
      loadVllmApiKeyImpl: () => null,
      runCurlProbeImpl: (argv) => {
        probedArgv.push(...argv);
        return {
          ok: true,
          httpStatus: 200,
          curlStatus: 0,
          body: '{"data":[{"id":"served-model"}]}',
          stderr: "",
          message: "HTTP 200",
        };
      },
    });

    expect(selectorsProbed).toContain("default");
    expect(selectorsProbed).toContain(AMBIENT_CONTEXT);
    const endpoint = probedArgv.find((arg) => arg.includes("/v1/models")) ?? "";
    expect(endpoint).toContain(`:${PUBLISHED_HOST_PORT}`);
  });
});

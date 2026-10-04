// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dockerCapture: vi.fn(),
}));

vi.mock("../adapters/docker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../adapters/docker")>()),
  dockerCapture: mocks.dockerCapture,
}));

import {
  isNemoClawManagedVllmRunning,
  NEMOCLAW_VLLM_CONTAINER_NAME,
  NEMOCLAW_VLLM_MANAGED_LABEL,
} from "./vllm";
import {
  DUAL_STATION_VLLM_CLUSTER_LABEL,
  DUAL_STATION_VLLM_ENDPOINT_LABEL,
  DUAL_STATION_VLLM_ROLE_LABEL,
} from "./vllm-station-cluster-lifecycle";

const MANAGED_CONTAINER_ID = "a".repeat(64);

function vllmContainerRow(
  containerName: string,
  {
    id = MANAGED_CONTAINER_ID,
    label = "true",
    state = "exited",
    dualRole = "",
    dualEndpoint = "",
    dualCluster = "",
  } = {},
): string {
  return [id, containerName, state, label, dualRole, dualEndpoint, dualCluster].join("|");
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllEnvs());

describe("managed vLLM ownership", () => {
  it("recognizes only the exact running container with the managed label", () => {
    mocks.dockerCapture.mockReturnValue(
      vllmContainerRow(NEMOCLAW_VLLM_CONTAINER_NAME, { state: "running" }),
    );

    expect(isNemoClawManagedVllmRunning()).toBe(true);
    expect(mocks.dockerCapture).toHaveBeenCalledWith(
      [
        "container",
        "ls",
        "--all",
        "--no-trunc",
        "--filter",
        `name=^/${NEMOCLAW_VLLM_CONTAINER_NAME}$`,
        "--format",
        [
          "{{.ID}}",
          "{{.Names}}",
          "{{.State}}",
          `{{.Label "${NEMOCLAW_VLLM_MANAGED_LABEL}"}}`,
          `{{.Label "${DUAL_STATION_VLLM_ROLE_LABEL}"}}`,
          `{{.Label "${DUAL_STATION_VLLM_ENDPOINT_LABEL}"}}`,
          `{{.Label "${DUAL_STATION_VLLM_CLUSTER_LABEL}"}}`,
        ].join("|"),
      ],
      expect.objectContaining({ timeout: 10_000 }),
    );
  });

  it("recognizes a running dual-Station head without treating it as legacy ownership", () => {
    mocks.dockerCapture.mockReturnValue(
      vllmContainerRow(NEMOCLAW_VLLM_CONTAINER_NAME, {
        state: "running",
        dualRole: "head",
        dualEndpoint: "http://192.168.100.1:8000",
        dualCluster: "f".repeat(64),
      }),
    );

    expect(isNemoClawManagedVllmRunning()).toBe(true);
  });

  it("checks the canonical local daemon before an ambient remote Docker host", () => {
    vi.stubEnv("DOCKER_HOST", "ssh://builder.example.test");
    vi.stubEnv("DOCKER_CONTEXT", undefined);
    mocks.dockerCapture.mockImplementation(
      (_args: readonly string[], options?: { env?: NodeJS.ProcessEnv }) =>
        options?.env?.DOCKER_CONTEXT === "default"
          ? vllmContainerRow(NEMOCLAW_VLLM_CONTAINER_NAME, {
              state: "running",
              dualRole: "head",
              dualEndpoint: "http://192.168.100.1:8000",
              dualCluster: "f".repeat(64),
            })
          : "",
    );

    expect(isNemoClawManagedVllmRunning()).toBe(true);
    expect(mocks.dockerCapture).toHaveBeenCalledTimes(1);
    expect(mocks.dockerCapture.mock.calls[0]?.[1]?.env).toMatchObject({
      DOCKER_CONTEXT: "default",
    });
    expect(mocks.dockerCapture.mock.calls[0]?.[1]?.env).not.toHaveProperty("DOCKER_HOST");
  });

  it.each([
    vllmContainerRow(NEMOCLAW_VLLM_CONTAINER_NAME),
    vllmContainerRow(NEMOCLAW_VLLM_CONTAINER_NAME, { label: "" }),
    vllmContainerRow(NEMOCLAW_VLLM_CONTAINER_NAME, { label: "false", state: "running" }),
    "",
    "malformed",
    `${vllmContainerRow(NEMOCLAW_VLLM_CONTAINER_NAME)}\n${vllmContainerRow(NEMOCLAW_VLLM_CONTAINER_NAME)}`,
  ])("fails closed for inspect output %j", (output) => {
    mocks.dockerCapture.mockReturnValue(output);
    expect(isNemoClawManagedVllmRunning()).toBe(false);
  });

  it("fails closed when Docker inspection throws", () => {
    mocks.dockerCapture.mockImplementation(() => {
      throw new Error("docker unavailable");
    });
    expect(isNemoClawManagedVllmRunning()).toBe(false);
  });
});

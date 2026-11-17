// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const docker = vi.hoisted(() => ({ capture: vi.fn(), forceRm: vi.fn(), run: vi.fn() }));
vi.mock("../../adapters/docker/local-model-runtime", () => ({
  dockerCapture: docker.capture,
  dockerForceRm: docker.forceRm,
  dockerRun: docker.run,
}));

import { runtimeAuthFingerprint } from "../serving/runtime-auth-fingerprint";
import { cleanupLocalModelRuntimes, retireHostLocalVllmRuntime } from "./cleanup";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("managed vLLM cleanup daemon", () => {
  it.each([
    {
      operation: "bearerless retirement",
      authenticated: false,
      cleanup: retireHostLocalVllmRuntime,
      expected: { status: "removed" },
    },
    {
      operation: "authenticated retirement",
      authenticated: true,
      cleanup: retireHostLocalVllmRuntime,
      expected: { status: "removed" },
    },
    {
      operation: "recorded uninstall",
      authenticated: true,
      cleanup: cleanupLocalModelRuntimes,
      expected: { ok: true },
    },
  ])("uses the default daemon for $operation", ({ authenticated, cleanup, expected }) => {
    const homeDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-vllm-cleanup-daemon-")),
    );
    const stateDir = path.join(homeDir, ".nemoclaw");
    const apiKey = "a".repeat(64);
    const containerId = "b".repeat(64);
    const labels = {
      "com.nvidia.nemoclaw.managed-vllm": "true",
      ...(authenticated
        ? { "com.nvidia.nemoclaw.managed-vllm-auth": runtimeAuthFingerprint(apiKey) }
        : {}),
    };
    const owned = JSON.stringify([
      {
        Id: containerId,
        Name: "/nemoclaw-vllm",
        Config: { Labels: labels, Env: authenticated ? [`VLLM_API_KEY=${apiKey}`] : [] },
      },
    ]);
    docker.run.mockReturnValue({ status: 0 });
    docker.capture.mockImplementation((_args, options) =>
      options?.env?.DOCKER_CONTEXT === "default" ? owned : "",
    );
    docker.forceRm.mockReturnValue({ status: 0 });
    vi.stubEnv("DOCKER_HOST", "unix:///other/docker.sock");
    vi.stubEnv("DOCKER_CONTEXT", "other-local");
    vi.stubEnv("DOCKER_CONFIG", "/other/config");
    try {
      fs.mkdirSync(stateDir, { mode: 0o700 });
      authenticated &&
        fs.writeFileSync(path.join(stateDir, "dual-station-vllm-api-key"), `${apiKey}\n`, {
          mode: 0o600,
        });
      expect(cleanup({ homeDir })).toMatchObject(expected);
      expect(docker.forceRm).toHaveBeenCalledWith(
        containerId,
        expect.objectContaining({
          env: expect.objectContaining({ DOCKER_CONTEXT: "default" }),
          replaceEnv: true,
        }),
      );
      const observed = [docker.run, docker.capture, docker.forceRm].flatMap((mock) =>
        mock.mock.calls.map(([, options]) => ({
          replaceEnv: options.replaceEnv,
          context: options.env?.DOCKER_CONTEXT,
          selectors: Object.keys(options.env ?? {}).filter((name) => name.startsWith("DOCKER_")),
        })),
      );
      expect(observed).toEqual([
        { replaceEnv: true, context: "default", selectors: ["DOCKER_CONTEXT"] },
        { replaceEnv: true, context: "default", selectors: ["DOCKER_CONTEXT"] },
        { replaceEnv: true, context: "default", selectors: ["DOCKER_CONTEXT"] },
      ]);
    } finally {
      fs.rmSync(homeDir, { force: true, recursive: true });
    }
  });
});

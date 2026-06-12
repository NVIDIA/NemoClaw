// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { buildDockerProbeEnv, redactDockerProbeResult } from "../fixtures/docker-probe.ts";
import { SecretStore } from "../fixtures/secrets.ts";

describe("DockerProbe secret hygiene", () => {
  it("builds Docker command env through the fixture-owned allowlist boundary", () => {
    const env = buildDockerProbeEnv(
      {
        PATH: "/usr/bin",
        HOME: "/tmp/home",
        DOCKER_HOST: "unix:///tmp/docker.sock",
        DOCKER_CONTEXT: "desktop-linux",
        DOCKERHUB_TOKEN: "dockerhub-secret-token",
        NVIDIA_API_KEY: "nvapi-secret-value",
        RANDOM_SECRET: "other-secret-value",
      },
      "/tmp/docker-config",
    );

    expect(env).toMatchObject({
      PATH: expect.stringContaining("/usr/bin"),
      HOME: "/tmp/home",
      DOCKER_HOST: "unix:///tmp/docker.sock",
      DOCKER_CONTEXT: "desktop-linux",
      DOCKER_CONFIG: "/tmp/docker-config",
    });
    expect(env).not.toHaveProperty("DOCKERHUB_TOKEN");
    expect(env).not.toHaveProperty("NVIDIA_API_KEY");
    expect(env).not.toHaveProperty("RANDOM_SECRET");
  });

  it("redacts secret-shaped Docker diagnostics before artifacts are written", () => {
    const secret = "nvapi-supersecret-token";
    const secrets = new SecretStore({ NVIDIA_API_KEY: secret }, (message) => {
      throw new Error(message ?? "unexpected skip");
    });

    const result = redactDockerProbeResult(
      {
        command: ["docker", "run", "--env", `NVIDIA_API_KEY=${secret}`],
        exitCode: 1,
        signal: null,
        stdout: `stdout ${secret}`,
        stderr: `stderr TOKEN=${secret}`,
        error: `error ${secret}`,
      },
      (text, extraValues) => secrets.redact(text, extraValues),
    );

    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.command.join(" ")).toContain("[REDACTED]");
    expect(result.stdout).toContain("[REDACTED]");
    expect(result.stderr).toContain("[REDACTED]");
    expect(result.error).toContain("[REDACTED]");
  });
});

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ArtifactSink } from "../fixtures/artifacts.ts";
import {
  buildDockerProbeEnv,
  DockerProbe,
  redactDockerProbeResult,
} from "../fixtures/docker-probe.ts";
import { SecretStore } from "../fixtures/secrets.ts";

async function readArtifact(root: string, relativePath: string): Promise<string> {
  return fs.readFile(path.join(root, relativePath), "utf8");
}

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

  it("writes DockerProbe stdout, stderr, and result artifacts after redaction", async () => {
    const secret = "docker-probe-artifact-secret";
    const artifactsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "docker-probe-artifacts-"));
    const artifacts = new ArtifactSink(artifactsRoot);
    const secrets = new SecretStore({ NEMOCLAW_TOKEN: secret }, (message) => {
      throw new Error(message ?? "unexpected skip");
    });
    const probe = new DockerProbe(
      artifacts,
      (text, extraValues) => secrets.redact(text, extraValues),
      (_command, args) => ({
        pid: 123,
        output: [null, `stdout ${secret} ${args.join(" ")}`, `stderr ${secret}`],
        stdout: `stdout ${secret} ${args.join(" ")}`,
        stderr: `stderr ${secret}`,
        status: 17,
        signal: null,
        error: new Error(`error ${secret}`),
      }),
    );

    const result = await probe.run(["logs", "hermes"], { artifactName: "diag-hermes-logs" });

    expect(JSON.stringify(result)).not.toContain(secret);
    for (const relativePath of [
      "docker/001-diag-hermes-logs.stdout.txt",
      "docker/001-diag-hermes-logs.stderr.txt",
      "docker/001-diag-hermes-logs.result.json",
    ]) {
      const artifact = await readArtifact(artifactsRoot, relativePath);
      expect(artifact).not.toContain(secret);
      expect(artifact).toContain("[REDACTED]");
    }
  });

  it("redacts diagnostic-style Docker inspect, logs, process, start-log, and gateway-log artifacts", async () => {
    const secret = "docker-diagnostic-artifact-secret";
    const diagnostics = new Map([
      ["diag-hermes-inspect", `inspect env TOKEN=${secret}`],
      ["diag-hermes-logs", `container log Bearer ${secret}`],
      ["diag-hermes-process", `process --token=${secret}`],
      ["diag-hermes-start-log", `nemoclaw start log ${secret}`],
      ["diag-hermes-gateway-log", `gateway log ${secret}`],
    ]);
    const artifactsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "docker-probe-diagnostics-"));
    const artifacts = new ArtifactSink(artifactsRoot);
    const secrets = new SecretStore({ NEMOCLAW_TOKEN: secret }, (message) => {
      throw new Error(message ?? "unexpected skip");
    });
    const probe = new DockerProbe(
      artifacts,
      (text, extraValues) => secrets.redact(text, extraValues),
      (_command, args) => {
        const artifactName = args.at(-1) ?? "unknown";
        const stdout = diagnostics.get(artifactName) ?? `diagnostic ${secret}`;
        return {
          pid: 123,
          output: [null, stdout, `stderr ${secret}`],
          stdout,
          stderr: `stderr ${secret}`,
          status: 0,
          signal: null,
        };
      },
    );

    for (const artifactName of diagnostics.keys()) {
      await probe.run(["fake-diagnostic", artifactName], { artifactName });
    }

    let sequence = 0;
    for (const artifactName of diagnostics.keys()) {
      const artifactBase = `docker/${String(++sequence).padStart(3, "0")}-${artifactName}`;
      for (const suffix of ["stdout.txt", "stderr.txt", "result.json"]) {
        const artifact = await readArtifact(artifactsRoot, `${artifactBase}.${suffix}`);
        expect(artifact, `${artifactBase}.${suffix}`).not.toContain(secret);
        expect(artifact, `${artifactBase}.${suffix}`).toContain("[REDACTED]");
      }
    }
  });
});

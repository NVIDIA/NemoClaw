// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// @module-tag e2e/credential-free

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { expect, test } from "vitest";

import { probeDockerStorage } from "../src/lib/inference/vllm-storage";

const TARGET_ID = "vllm-docker-storage";
const DOCKER_HOST = "unix:///run/docker.sock";
const RUN_REAL_DOCKER =
  process.env.E2E_TARGET_ID === TARGET_ID ||
  process.env.NEMOCLAW_RUN_VLLM_STORAGE_DOCKER_E2E === "1";
const realDockerTest = RUN_REAL_DOCKER ? test : test.skip;

interface DockerInfo {
  DockerRootDir?: unknown;
  OSType?: unknown;
  ServerVersion?: unknown;
}

function dockerEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, DOCKER_HOST };
  delete env.DOCKER_CONTEXT;
  return env;
}

function writeEvidence(evidence: Record<string, unknown>): void {
  const artifactDir = process.env.E2E_ARTIFACT_DIR;
  if (!artifactDir) return;
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(
    path.join(artifactDir, `${TARGET_ID}.json`),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
}

realDockerTest(
  "measures real Docker storage through the /run/docker.sock alias (#7039)",
  () => {
    expect(process.platform, "this release acceptance requires a native Linux host").toBe("linux");
    expect(
      fs.statSync("/run/docker.sock").isSocket(),
      "/run/docker.sock must be a Unix socket",
    ).toBe(true);

    const env = dockerEnvironment();
    const infoResult = spawnSync("docker", ["info", "--format", "{{json .}}"], {
      encoding: "utf8",
      env,
      timeout: 15_000,
    });
    expect(
      infoResult.status,
      `docker info through ${DOCKER_HOST} failed:\n${
        infoResult.error?.message || infoResult.stderr || infoResult.stdout
      }`,
    ).toBe(0);

    const info = JSON.parse(infoResult.stdout) as DockerInfo;
    expect(info.OSType).toBe("linux");
    expect(typeof info.DockerRootDir).toBe("string");
    const dockerRootDir = String(info.DockerRootDir);
    expect(path.isAbsolute(dockerRootDir)).toBe(true);
    const dockerRootStats = fs.statfsSync(dockerRootDir, { bigint: true });
    const dockerRootAvailableBytes = dockerRootStats.bavail * dockerRootStats.bsize;
    expect(dockerRootAvailableBytes).toBeGreaterThan(0n);

    const previousDockerHost = process.env.DOCKER_HOST;
    const previousDockerContext = process.env.DOCKER_CONTEXT;
    process.env.DOCKER_HOST = DOCKER_HOST;
    delete process.env.DOCKER_CONTEXT;
    try {
      const probe = probeDockerStorage();
      expect(probe.ok, probe.ok ? undefined : probe.reason).toBe(true);
      if (!probe.ok) return;

      const capacityStats = fs.statfsSync(probe.capacity.path, { bigint: true });
      const measuredAvailableBytes = capacityStats.bavail * capacityStats.bsize;
      expect(probe.capacity.availableBytes).toBe(measuredAvailableBytes);
      expect(probe.capacity.availableBytes).toBeGreaterThan(0n);

      const checkoutResult = spawnSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
        timeout: 5_000,
      });
      expect(
        checkoutResult.status,
        `could not record the validated checkout: ${
          checkoutResult.error?.message || checkoutResult.stderr || checkoutResult.stdout
        }`,
      ).toBe(0);
      const checkoutSha = checkoutResult.stdout.trim();
      expect(checkoutSha).toMatch(/^[0-9a-f]{40}$/u);
      const evidence = {
        schemaVersion: 1,
        checkoutSha,
        platform: process.platform,
        architecture: process.arch,
        dockerHost: DOCKER_HOST,
        dockerServerVersion: info.ServerVersion,
        dockerRootDir,
        dockerRootAvailableBytes: String(dockerRootAvailableBytes),
        measuredPath: probe.capacity.path,
        measuredSource: probe.capacity.source,
        measuredAvailableBytes: String(probe.capacity.availableBytes),
      };
      writeEvidence(evidence);
      console.info(`[${TARGET_ID}] ${JSON.stringify(evidence)}`);
    } finally {
      if (previousDockerHost === undefined) delete process.env.DOCKER_HOST;
      else process.env.DOCKER_HOST = previousDockerHost;
      if (previousDockerContext === undefined) delete process.env.DOCKER_CONTEXT;
      else process.env.DOCKER_CONTEXT = previousDockerContext;
    }
  },
  30_000,
);

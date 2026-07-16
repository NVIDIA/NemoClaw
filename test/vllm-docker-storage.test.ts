// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// @module-tag e2e/credential-free

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import { __test, detectVllmProfile } from "../src/lib/inference/vllm";
import {
  imageStorageRequirementBytes,
  probeDockerStorage,
} from "../src/lib/inference/vllm-storage";

const TARGET_ID = "vllm-docker-storage";
const DOCKER_HOST = "unix:///run/docker.sock";
const RELEASE_CANDIDATE_VERSION = "v0.0.85";
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
  const persist =
    artifactDir === undefined
      ? () => undefined
      : () => {
          fs.mkdirSync(artifactDir, { recursive: true });
          fs.writeFileSync(
            path.join(artifactDir, `${TARGET_ID}.json`),
            `${JSON.stringify(evidence, null, 2)}\n`,
          );
        };
  persist();
}

function validationSubject(
  checkoutSha: string,
  candidateVersion = process.env.NEMOCLAW_CANDIDATE_VERSION,
):
  | { kind: "checkout"; checkoutSha: string }
  | { kind: "release-candidate"; version: string; checkoutSha: string } {
  if (!candidateVersion) return { kind: "checkout", checkoutSha };
  if (candidateVersion !== RELEASE_CANDIDATE_VERSION) {
    throw new Error(
      `NEMOCLAW_CANDIDATE_VERSION must be exactly ${RELEASE_CANDIDATE_VERSION}; received ${JSON.stringify(candidateVersion)}`,
    );
  }
  return { kind: "release-candidate", version: candidateVersion, checkoutSha };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

test("distinguishes checkout evidence from exact v0.0.85 release acceptance (#7039)", () => {
  const checkoutSha = "a".repeat(40);
  expect(validationSubject(checkoutSha, undefined)).toEqual({ kind: "checkout", checkoutSha });
  expect(validationSubject(checkoutSha, RELEASE_CANDIDATE_VERSION)).toEqual({
    kind: "release-candidate",
    version: RELEASE_CANDIDATE_VERSION,
    checkoutSha,
  });
  expect(() => validationSubject(checkoutSha, "0.0.85")).toThrow(
    `NEMOCLAW_CANDIDATE_VERSION must be exactly ${RELEASE_CANDIDATE_VERSION}`,
  );
  expect(() => validationSubject(checkoutSha, "v0.0.84")).toThrow(
    `NEMOCLAW_CANDIDATE_VERSION must be exactly ${RELEASE_CANDIDATE_VERSION}`,
  );
});

realDockerTest(
  "accepts a real Linux profile from the measured /run/docker.sock capacity (#7039)",
  async () => {
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

    vi.stubEnv("DOCKER_HOST", DOCKER_HOST);
    vi.stubEnv("DOCKER_CONTEXT", undefined);
    const capacitySamples = new Map<string, { bavail: bigint; bsize: bigint }>();
    const probe = probeDockerStorage({
      statfs: (target) => {
        const sample = fs.statfsSync(target, { bigint: true });
        capacitySamples.set(target, sample);
        return sample;
      },
    });
    expect(probe.ok, probe.ok ? undefined : probe.reason).toBe(true);
    assert(probe.ok);

    const capacityStats = capacitySamples.get(probe.capacity.path);
    assert(capacityStats, `the probe did not sample ${probe.capacity.path}`);
    const measuredAvailableBytes = capacityStats.bavail * capacityStats.bsize;
    expect(probe.capacity.availableBytes).toBe(measuredAvailableBytes);

    const profile = detectVllmProfile({ platform: "linux", type: "nvidia" });
    assert(profile, "the release acceptance host must support the real Linux vLLM profile");
    const requiredBytes = imageStorageRequirementBytes(profile.imageDownloadSizeBytes);
    expect(probe.capacity.availableBytes).toBeGreaterThanOrEqual(requiredBytes);

    const promptFn = vi.fn(async () => {
      throw new Error("the sufficient-capacity path must not prompt");
    });
    const warning = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const accepted = await __test.imageStorageAccepted(
      profile,
      { hasImage: false, nonInteractive: true, promptFn },
      probe,
    );
    expect(accepted).toBe(true);
    expect(promptFn).not.toHaveBeenCalled();
    expect(warning).not.toHaveBeenCalled();

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
      validationSubject: validationSubject(checkoutSha),
      platform: process.platform,
      architecture: process.arch,
      dockerHost: DOCKER_HOST,
      dockerServerVersion: info.ServerVersion,
      dockerRootDir,
      dockerRootAvailableBytes: String(dockerRootAvailableBytes),
      measuredPath: probe.capacity.path,
      measuredSource: probe.capacity.source,
      measuredAvailableBytes: String(probe.capacity.availableBytes),
      requiredAvailableBytes: String(requiredBytes),
      imageStorageAccepted: accepted,
    };
    writeEvidence(evidence);
    console.info(`[${TARGET_ID}] ${JSON.stringify(evidence)}`);
  },
  30_000,
);

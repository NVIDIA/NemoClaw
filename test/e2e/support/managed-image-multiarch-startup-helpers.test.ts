// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DOCKER_ENGINE_27_MINIMUM_CLEANUP_PROCESS_TIMEOUT_MS,
  DOCKER_ENGINE_27_MINIMUM_PROBE_TIMEOUT_MS,
  dockerEngine27ReceiptDaemonName,
  dockerEngine27ReceiptIdentityArguments,
  finalizeDockerEngine27ReceiptProbe,
  requireDockerResourceAbsent,
  validateDockerEngine27SeedIsolation,
} from "../../../scripts/checks/docker-engine-27-receipt-transfer-e2e.ts";
import {
  protectedManagedImageDispatchEnvironment,
  readRegularArtifact,
} from "../live/managed-image-multiarch-startup-helpers.ts";

const sha = "a".repeat(40);
let temporaryRoot = "";

beforeEach(() => {
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-multiarch-helper-"));
  const artifacts = path.join(temporaryRoot, "artifacts");
  fs.mkdirSync(artifacts);
  vi.stubEnv("E2E_ARTIFACT_DIR", artifacts);
  vi.stubEnv("GITHUB_RUN_ATTEMPT", "1");
  vi.stubEnv("GITHUB_RUN_ID", "123");
  vi.stubEnv("GITHUB_WORKSPACE", temporaryRoot);
  vi.stubEnv("NEMOCLAW_PROTECTED_MANAGED_IMAGE_BASE_SHA", sha);
  vi.stubEnv("NEMOCLAW_PROTECTED_MANAGED_IMAGE_COHORT", "protected-123-1");
  vi.stubEnv("NEMOCLAW_PROTECTED_MANAGED_IMAGE_CONTRACT", path.join(artifacts, "contract.json"));
  vi.stubEnv("NEMOCLAW_PROTECTED_MANAGED_IMAGE_EVIDENCE", path.join(artifacts, "evidence.json"));
  vi.stubEnv("NEMOCLAW_PROTECTED_MANAGED_IMAGE_HEAD_SHA", sha);
  vi.stubEnv("NEMOCLAW_PROTECTED_MANAGED_IMAGE_PLATFORM", "linux/amd64");
  vi.stubEnv("NEMOCLAW_PROTECTED_MANAGED_IMAGE_WORKFLOW_SHA", sha);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(temporaryRoot, { force: true, recursive: true });
});

describe("protected managed-image startup helpers", () => {
  it("preserves the probe failure and attempts fixture cleanup after daemon cleanup fails", () => {
    const cleanupFixture = vi.fn();

    expect(() =>
      finalizeDockerEngine27ReceiptProbe(
        new Error("receipt transfer failed"),
        () => {
          throw new Error("daemon cleanup failed");
        },
        cleanupFixture,
      ),
    ).toThrow(/receipt transfer failed.*daemon cleanup failed/u);
    expect(cleanupFixture).toHaveBeenCalledOnce();
  });

  it("derives one Docker 27 identity for probe and cleanup on each matrix platform", () => {
    const amd64 = dockerEngine27ReceiptDaemonName(123, 4, "linux/amd64");
    const arm64 = dockerEngine27ReceiptDaemonName(123, 4, "linux/arm64");
    const sharedIdentity = dockerEngine27ReceiptIdentityArguments(123, 4, "linux/amd64");
    const probeArgs = ["docker-engine-27-receipt-transfer-e2e.ts", ...sharedIdentity];
    const cleanupArgs = [
      "docker-engine-27-receipt-transfer-e2e.ts",
      "--cleanup-only",
      ...sharedIdentity,
    ];

    expect(amd64).toBe("nemoclaw-receipt-engine27-123-4-linux-amd64");
    expect(arm64).toBe("nemoclaw-receipt-engine27-123-4-linux-arm64");
    expect(amd64).not.toBe(arm64);
    expect(cleanupArgs.filter((arg) => arg !== "--cleanup-only")).toEqual(probeArgs);
    expect(sharedIdentity).toEqual([
      "--run-id",
      "123",
      "--run-attempt",
      "4",
      "--platform",
      "linux/amd64",
    ]);
  });

  it("bounds the complete Docker 27 probe and external cleanup", () => {
    expect(30 * 60_000).toBeGreaterThanOrEqual(DOCKER_ENGINE_27_MINIMUM_PROBE_TIMEOUT_MS);
    expect(90_000).toBeGreaterThanOrEqual(DOCKER_ENGINE_27_MINIMUM_CLEANUP_PROCESS_TIMEOUT_MS);
  });

  it("requires numeric root and every receipt seed isolation control", () => {
    const secureSeed = {
      Config: { User: "0" },
      HostConfig: {
        CapDrop: ["ALL"],
        Mounts: [
          {
            Type: "volume",
            Target: "/run/nemoclaw/managed-startup-receipt-transfer",
          },
        ],
        NetworkMode: "none",
        Privileged: false,
        ReadonlyRootfs: true,
        SecurityOpt: ["no-new-privileges"],
      },
    };

    expect(() => validateDockerEngine27SeedIsolation(secureSeed)).not.toThrow();
    expect(() =>
      validateDockerEngine27SeedIsolation({ ...secureSeed, Config: { User: "0:0" } }),
    ).toThrow("receipt seed did not use numeric root");
    expect(() =>
      validateDockerEngine27SeedIsolation({
        ...secureSeed,
        HostConfig: { ...secureSeed.HostConfig, Privileged: true },
      }),
    ).toThrow("receipt seed was privileged");
    expect(() =>
      validateDockerEngine27SeedIsolation({
        ...secureSeed,
        HostConfig: { ...secureSeed.HostConfig, CapDrop: [] },
      }),
    ).toThrow("receipt seed retained capabilities");
  });

  it("proves cleanup only from Docker's explicit absence response", () => {
    expect(() =>
      requireDockerResourceAbsent(
        { status: 1, stderr: "Error: No such container: receipt-seed", stdout: "" },
        "receipt seed",
      ),
    ).not.toThrow();
    expect(() =>
      requireDockerResourceAbsent(
        {
          error: new Error("spawnSync docker ETIMEDOUT"),
          status: null,
          stderr: "",
          stdout: "",
        },
        "receipt seed",
      ),
    ).toThrow("receipt seed absence was not proven");
    expect(() =>
      requireDockerResourceAbsent(
        { status: 1, stderr: "permission denied", stdout: "" },
        "receipt seed",
      ),
    ).toThrow("receipt seed absence was not proven");
  });

  it("parses exact protected dispatch identity", () => {
    expect(protectedManagedImageDispatchEnvironment()).toMatchObject({
      baseSha: sha,
      cohort: "protected-123-1",
      headSha: sha,
      platform: "linux/amd64",
      runAttempt: 1,
      runId: 123,
      workflowSha: sha,
    });
  });

  it("rejects identity values outside the canonical contract", () => {
    vi.stubEnv("NEMOCLAW_PROTECTED_MANAGED_IMAGE_COHORT", "other-123-1");
    expect(() => protectedManagedImageDispatchEnvironment()).toThrow(
      "protected managed-image dispatch identity is invalid",
    );
  });

  it("requires an explicit protected candidate head independent of PR risk signals", () => {
    vi.stubEnv("NEMOCLAW_PROTECTED_MANAGED_IMAGE_HEAD_SHA", "");
    vi.stubEnv("NEMOCLAW_E2E_EXPECTED_SHA", sha);

    expect(() => protectedManagedImageDispatchEnvironment()).toThrow(
      "NEMOCLAW_PROTECTED_MANAGED_IMAGE_HEAD_SHA is required",
    );
  });

  it("reads a bounded file through its opened descriptor and rejects a symlink", () => {
    const artifacts = path.join(temporaryRoot, "artifacts");
    const artifact = path.join(artifacts, "contract.json");
    const symlink = path.join(artifacts, "contract-link.json");
    fs.writeFileSync(artifact, '{"contractVersion":1}');
    fs.symlinkSync(artifact, symlink);

    expect(readRegularArtifact(artifact, artifacts).toString("utf8")).toBe('{"contractVersion":1}');
    expect(() => readRegularArtifact(symlink, artifacts)).toThrow();
  });
});

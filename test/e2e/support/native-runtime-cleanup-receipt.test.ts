// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const RECEIPT_SCRIPT = path.join(process.cwd(), "scripts/e2e/native-runtime-cleanup-receipt.sh");
const TARGET_ENV = {
  ACCOUNT_HOME: "/recovery/account-home",
  APPARMOR_PROFILE: "/recovery/policies/podman.profile",
  CONTAINERS_CONFIG: "/recovery/config/containers.fixture.conf",
  HELPER_DIRECTORY: "/recovery/helpers",
  MODEL_DIRECTORY: "/recovery/model-data",
  OWNERSHIP_MARKER: "/recovery/owner-marker",
  PASTA_APPARMOR_PROFILE: "/recovery/policies/pasta.profile",
  PASTA_EXECUTABLE: "/recovery/helpers/pasta-fixture",
  PODMAN_EXECUTABLE: "/recovery/bin/podman-fixture",
  REGISTRY_AUTH_DIRECTORY: "/recovery/registry",
  REGISTRY_AUTH_FILE: "/recovery/registry/fixture-auth.json",
  RESOURCE_DIRECTORY: "/recovery/resources",
  RUNNER_CONTRACT: "/recovery/config/runner-fixture.json",
  RUNTIME_DIRECTORY: "/recovery/runtime",
  RUNTIME_DIRECTORY_UNIT: "runtime-fixture.service",
  STORAGE_CONFIG: "/recovery/config/storage.fixture.conf",
  STORAGE_CONFIG_DIRECTORY: "/recovery/config",
  USER_MANAGER_DROPIN: "/recovery/systemd/dropins/fixture.conf",
  USER_MANAGER_DROPIN_DIRECTORY: "/recovery/systemd/dropins",
  USER_MANAGER_UNIT: "manager-fixture.service",
} as const;

function runReceipt(overrides: Record<string, string> = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-cleanup-receipt-"));
  const receipt = path.join(directory, "recovery", "receipt.json");
  const result = spawnSync("bash", [RECEIPT_SCRIPT], {
    encoding: "utf8",
    env: {
      ...process.env,
      ACCOUNT: "nemoclawq",
      ACCOUNT_GID: "12345",
      ACCOUNT_UID: "12345",
      CLEANUP_RECEIPT_PATH: receipt,
      CLEANUP_STAGE: "remove-storage",
      CLEANUP_STATUS: "failed",
      COMPLETED_STAGES: "validate-ownership,stop-processes,remove-systemd",
      FIRST_FAILED_STAGE: "remove-storage",
      GITHUB_RUN_ATTEMPT: "2",
      GITHUB_RUN_ID: "77",
      ...TARGET_ENV,
      ...overrides,
    },
  });
  return {
    cleanup: () => fs.rmSync(directory, { force: true, recursive: true }),
    receipt,
    result,
  };
}

describe("native runtime cleanup recovery receipt", () => {
  it("records run-owned targets and the first failed cleanup stage", () => {
    const fixture = runReceipt();
    try {
      expect(fixture.result.status, fixture.result.stderr).toBe(0);
      const receipt = JSON.parse(fs.readFileSync(fixture.receipt, "utf8"));
      expect(receipt).toMatchObject({
        kind: "nemoclaw-native-runtime-cleanup-receipt-v1",
        run: { id: "77", attempt: 2 },
        account: { name: "nemoclawq", uid: 12345, gid: 12345 },
        cleanup: {
          status: "failed",
          currentStage: "remove-storage",
          completedStages: ["validate-ownership", "stop-processes", "remove-systemd"],
          firstFailedStage: "remove-storage",
        },
      });
      expect(receipt.targets).toEqual({
        ownershipMarker: TARGET_ENV.OWNERSHIP_MARKER,
        home: TARGET_ENV.ACCOUNT_HOME,
        runtimeDirectory: TARGET_ENV.RUNTIME_DIRECTORY,
        runtimeDirectoryUnit: TARGET_ENV.RUNTIME_DIRECTORY_UNIT,
        userManagerUnit: TARGET_ENV.USER_MANAGER_UNIT,
        userManagerDropinDirectory: TARGET_ENV.USER_MANAGER_DROPIN_DIRECTORY,
        userManagerDropin: TARGET_ENV.USER_MANAGER_DROPIN,
        storageConfigDirectory: TARGET_ENV.STORAGE_CONFIG_DIRECTORY,
        storageConfig: TARGET_ENV.STORAGE_CONFIG,
        containersConfig: TARGET_ENV.CONTAINERS_CONFIG,
        apparmorProfile: TARGET_ENV.APPARMOR_PROFILE,
        pastaApparmorProfile: TARGET_ENV.PASTA_APPARMOR_PROFILE,
        registryAuthDirectory: TARGET_ENV.REGISTRY_AUTH_DIRECTORY,
        registryAuthFile: TARGET_ENV.REGISTRY_AUTH_FILE,
        runnerContract: TARGET_ENV.RUNNER_CONTRACT,
        podmanExecutable: TARGET_ENV.PODMAN_EXECUTABLE,
        helperDirectory: TARGET_ENV.HELPER_DIRECTORY,
        pastaExecutable: TARGET_ENV.PASTA_EXECUTABLE,
        resourceDirectory: TARGET_ENV.RESOURCE_DIRECTORY,
        modelDirectory: TARGET_ENV.MODEL_DIRECTORY,
      });
      expect(fs.statSync(fixture.receipt).mode & 0o777).toBe(0o600);
    } finally {
      fixture.cleanup();
    }
  });

  it("rewrites a recovery receipt after cleanup completes", () => {
    const fixture = runReceipt({
      CLEANUP_STAGE: "complete",
      CLEANUP_STATUS: "success",
      COMPLETED_STAGES:
        "validate-ownership,stop-processes,remove-systemd,remove-storage,remove-model-resources,remove-runtime-tools,remove-account,verify-removal,remove-ownership-marker",
      FIRST_FAILED_STAGE: "",
    });
    try {
      expect(fixture.result.status, fixture.result.stderr).toBe(0);
      expect(JSON.parse(fs.readFileSync(fixture.receipt, "utf8")).cleanup).toMatchObject({
        status: "success",
        currentStage: "complete",
        firstFailedStage: null,
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("records the initial cleanup stage before any stage completes", () => {
    const fixture = runReceipt({
      CLEANUP_STAGE: "validate-ownership",
      CLEANUP_STATUS: "in-progress",
      COMPLETED_STAGES: "",
      FIRST_FAILED_STAGE: "",
    });
    try {
      expect(fixture.result.status, fixture.result.stderr).toBe(0);
      expect(JSON.parse(fs.readFileSync(fixture.receipt, "utf8")).cleanup).toMatchObject({
        status: "in-progress",
        currentStage: "validate-ownership",
        completedStages: [],
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects a failed receipt without the current failed stage", () => {
    const fixture = runReceipt({ FIRST_FAILED_STAGE: "remove-account" });
    try {
      expect(fixture.result.status).toBe(1);
      expect(fixture.result.stderr).toContain(
        "failed cleanup receipt must identify its current stage",
      );
      expect(fs.existsSync(fixture.receipt)).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects an identified account without every recovery target", () => {
    const fixture = runReceipt({ MODEL_DIRECTORY: "" });
    try {
      expect(fixture.result.status).toBe(1);
      expect(fixture.result.stderr).toContain(
        "cleanup receipt model-directory is required for an identified account",
      );
      expect(fs.existsSync(fixture.receipt)).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });
});

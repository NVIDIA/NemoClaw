// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const RECEIPT_SCRIPT = path.join(process.cwd(), "scripts/e2e/native-runtime-cleanup-receipt.sh");

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
        targets: {
          ownershipMarker: "/run/nemoclaw-native-runtime-owner-77-2",
          runtimeDirectory: "/run/user/12345",
          userManagerDropin:
            "/run/systemd/system/user@12345.service.d/50-nemoclaw-native-runtime.conf",
          storageConfigDirectory: "/run/nemoclaw-native-runtime-77-2-12345",
          registryAuthFile: "/run/nemoclaw-native-runtime-77-2-12345/registry-auth/auth.json",
          podmanExecutable: "/nemoclaw-native-runtime-podman-77-2-12345",
          pastaExecutable: "/nemoclaw-native-runtime-helpers-77-2-12345/pasta",
          modelDirectory: "/var/tmp/nemoclaw-native-runtime-resources-77-2-12345/model",
        },
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
});

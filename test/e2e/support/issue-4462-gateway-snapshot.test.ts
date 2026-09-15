// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const SNAPSHOT_SCRIPT = path.join(
  import.meta.dirname,
  "..",
  "lib",
  "issue-4462-fresh-agent-gateway-snapshot.py",
);
const PUBLIC_KEY_BYTES = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1));
const DEVICE_ID = createHash("sha256").update(PUBLIC_KEY_BYTES).digest("hex");
const PUBLIC_KEY = PUBLIC_KEY_BYTES.toString("base64url");
const TOKEN = "fixture-device-token";

function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

describe("fresh-agent gateway snapshot artifacts", () => {
  it("reports paired scope state without device identity, key, or token values (#4462)", () => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), "nemoclaw-issue-4462-snapshot-"));
    const stateRoot = path.join(fixtureRoot, "state");
    const gatewayLog = path.join(fixtureRoot, "gateway.log");
    mkdirSync(path.join(stateRoot, "identity"), { recursive: true });
    mkdirSync(path.join(stateRoot, "devices"), { recursive: true });
    writeJson(path.join(stateRoot, "identity", "device.json"), {
      deviceId: DEVICE_ID,
      publicKey: PUBLIC_KEY,
    });
    writeJson(path.join(stateRoot, "devices", "pending.json"), {});
    writeJson(path.join(stateRoot, "devices", "paired.json"), {
      paired: {
        approvedScopes: ["operator.pairing", "operator.write"],
        clientId: "cli",
        clientMode: "cli",
        deviceId: DEVICE_ID,
        publicKey: PUBLIC_KEY,
        scopes: ["operator.pairing", "operator.write"],
        tokens: {
          operator: {
            role: "operator",
            scopes: ["operator.pairing", "operator.read", "operator.write"],
            token: TOKEN,
          },
        },
      },
    });
    writeFileSync(gatewayLog, "[agent] run fixture ended with stopReason=stop\n", "utf8");

    try {
      const result = spawnSync(
        "python3",
        [SNAPSHOT_SCRIPT, "1", "snapshot", "30", stateRoot, gatewayLog],
        { encoding: "utf8", timeout: 10_000 },
      );
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      const snapshot = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(snapshot).toEqual({
        activeOperatorTokenCount: 1,
        activeOperatorTokenScopes: ["operator.pairing", "operator.read", "operator.write"],
        approvedScopes: ["operator.pairing", "operator.write"],
        deviceScopes: ["operator.pairing", "operator.write"],
        gatewayCompletedRuns: 1,
        matchingPairedCount: 1,
        pairedCliCount: 1,
        pendingCount: 0,
        sameDevicePendingCount: 0,
      });
      const serialized = JSON.stringify(snapshot);
      expect(serialized).not.toContain(DEVICE_ID);
      expect(serialized).not.toContain(PUBLIC_KEY);
      expect(serialized).not.toContain(TOKEN);
    } finally {
      rmSync(fixtureRoot, { force: true, recursive: true });
    }
  });

  it("reports the completed gateway-run count after reaching the requested minimum (#4462)", () => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), "nemoclaw-issue-4462-runs-"));
    const gatewayLog = path.join(fixtureRoot, "gateway.log");
    writeFileSync(gatewayLog, "[agent] run fixture ended with stopReason=stop\n", "utf8");

    try {
      const result = spawnSync(
        "python3",
        [SNAPSHOT_SCRIPT, "1", "gateway-runs", "30", fixtureRoot, gatewayLog],
        { encoding: "utf8", timeout: 10_000 },
      );
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ gatewayCompletedRuns: 1 });
    } finally {
      rmSync(fixtureRoot, { force: true, recursive: true });
    }
  });

  it("rejects a local CLI identity whose device ID is not bound to its public key (#4462)", () => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), "nemoclaw-issue-4462-binding-"));
    const stateRoot = path.join(fixtureRoot, "state");
    const gatewayLog = path.join(fixtureRoot, "gateway.log");
    const mismatchedDeviceId = "0".repeat(64);
    mkdirSync(path.join(stateRoot, "identity"), { recursive: true });
    mkdirSync(path.join(stateRoot, "devices"), { recursive: true });
    writeJson(path.join(stateRoot, "identity", "device.json"), {
      deviceId: mismatchedDeviceId,
      publicKey: PUBLIC_KEY,
    });
    writeJson(path.join(stateRoot, "devices", "pending.json"), {});
    writeJson(path.join(stateRoot, "devices", "paired.json"), {
      paired: {
        clientId: "cli",
        clientMode: "cli",
        deviceId: mismatchedDeviceId,
        publicKey: PUBLIC_KEY,
      },
    });
    writeFileSync(gatewayLog, "[agent] run fixture ended with stopReason=stop\n", "utf8");

    try {
      const result = spawnSync(
        "python3",
        [SNAPSHOT_SCRIPT, "1", "snapshot", "30", stateRoot, gatewayLog],
        { encoding: "utf8", timeout: 10_000 },
      );
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("CLI identity binding is invalid");
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(PUBLIC_KEY);
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(mismatchedDeviceId);
    } finally {
      rmSync(fixtureRoot, { force: true, recursive: true });
    }
  });
});

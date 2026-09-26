// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { ADMIN_REQUEST_SELECTOR_PY } from "../fixtures/admin-request-selector.ts";

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
    try {
      const result = spawnSync("python3", [SNAPSHOT_SCRIPT, "30", stateRoot], {
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      const snapshot = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(snapshot).toEqual({
        activeOperatorTokenCount: 1,
        activeOperatorTokenScopes: ["operator.pairing", "operator.read", "operator.write"],
        approvedScopes: ["operator.pairing", "operator.write"],
        deviceScopes: ["operator.pairing", "operator.write"],
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

  it("reports redacted unsettled state when a pending request remains at the deadline", () => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), "nemoclaw-issue-4462-unsettled-"));
    const stateRoot = path.join(fixtureRoot, "state");
    const requestId = "4edc8df0-20d0-4308-b0e8-850843ae0cf4";
    mkdirSync(path.join(stateRoot, "identity"), { recursive: true });
    mkdirSync(path.join(stateRoot, "devices"), { recursive: true });
    writeJson(path.join(stateRoot, "identity", "device.json"), {
      deviceId: DEVICE_ID,
      publicKey: PUBLIC_KEY,
    });
    writeJson(path.join(stateRoot, "devices", "pending.json"), {
      pending: {
        clientId: "cli",
        clientMode: "cli",
        deviceId: DEVICE_ID,
        publicKey: PUBLIC_KEY,
        requestId,
      },
    });
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
    try {
      const result = spawnSync("python3", [SNAPSHOT_SCRIPT, "0.1", stateRoot], {
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("CLI pairing state is unsettled at observation deadline");
      expect(JSON.parse(result.stdout)).toEqual({
        activeOperatorTokenCount: 1,
        activeOperatorTokenScopes: ["operator.pairing", "operator.read", "operator.write"],
        approvedScopes: ["operator.pairing", "operator.write"],
        deviceScopes: ["operator.pairing", "operator.write"],
        matchingPairedCount: 1,
        pairedCliCount: 1,
        pendingCount: 1,
        sameDevicePendingCount: 1,
      });
      const output = `${result.stdout}\n${result.stderr}`;
      expect(output).not.toContain(DEVICE_ID);
      expect(output).not.toContain(PUBLIC_KEY);
      expect(output).not.toContain(TOKEN);
      expect(output).not.toContain(requestId);
    } finally {
      rmSync(fixtureRoot, { force: true, recursive: true });
    }
  });

  it("reads the canonical OpenClaw SQLite layout through the reviewed state adapter (#9844)", () => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), "nemoclaw-issue-4462-sqlite-"));
    const stateRoot = path.join(fixtureRoot, "state-root");
    const sqlitePath = path.join(stateRoot, "state", "openclaw.sqlite");
    const helperPath = path.join(fixtureRoot, "openclaw_pairing_state.py");
    const records = {
      identity: {
        deviceId: DEVICE_ID,
        publicKey: PUBLIC_KEY,
      },
      pending: {},
      paired: {
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
      },
    };
    mkdirSync(path.dirname(sqlitePath), { recursive: true });
    writeFileSync(sqlitePath, "canonical-layout-sentinel", "utf8");
    writeFileSync(
      helperPath,
      [
        "import json",
        `records = json.loads(${JSON.stringify(JSON.stringify(records))})`,
        "def read_openclaw_pairing_state(state_dir, timeout=1):",
        "    return records, {'stateDir': state_dir, 'timeout': timeout}",
        "",
      ].join("\n"),
      "utf8",
    );
    try {
      const result = spawnSync("python3", [SNAPSHOT_SCRIPT, "30", stateRoot, helperPath], {
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      const snapshot = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(snapshot).toEqual({
        activeOperatorTokenCount: 1,
        activeOperatorTokenScopes: ["operator.pairing", "operator.read", "operator.write"],
        approvedScopes: ["operator.pairing", "operator.write"],
        deviceScopes: ["operator.pairing", "operator.write"],
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

  it("selects the pending admin request with the canonical CLI identity (#12064)", () => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), "nemoclaw-issue-4462-selector-"));
    const stateRoot = path.join(fixtureRoot, "state-root");
    const sqlitePath = path.join(stateRoot, "state", "openclaw.sqlite");
    const helperPath = path.join(fixtureRoot, "openclaw_pairing_state.py");
    const devicesPath = path.join(fixtureRoot, "devices.json");
    const requestIdPath = path.join(fixtureRoot, "request-id");
    const requestId = "4edc8df0-20d0-4308-b0e8-850843ae0cf4";
    const identity = { deviceId: DEVICE_ID, publicKey: PUBLIC_KEY };
    const pending = {
      requestId,
      deviceId: DEVICE_ID,
      publicKey: PUBLIC_KEY,
      clientId: "cli",
      clientMode: "cli",
      role: "operator",
      roles: ["operator"],
      scopes: ["operator.admin", "operator.pairing", "operator.write"],
    };
    const paired = {
      deviceId: DEVICE_ID,
      publicKey: PUBLIC_KEY,
      clientId: "cli",
      clientMode: "cli",
      role: "operator",
      roles: ["operator"],
      scopes: ["operator.pairing", "operator.write"],
      approvedScopes: ["operator.pairing", "operator.write"],
      tokens: {
        operator: {
          role: "operator",
          scopes: ["operator.pairing", "operator.read", "operator.write"],
          token: TOKEN,
        },
      },
    };
    mkdirSync(path.dirname(sqlitePath), { recursive: true });
    writeFileSync(sqlitePath, "canonical-layout-sentinel", "utf8");
    writeFileSync(
      helperPath,
      [
        "import json",
        `records = json.loads(${JSON.stringify(JSON.stringify({ identity }))})`,
        "def read_openclaw_pairing_state(state_dir, timeout=1):",
        "    return records, {'stateDir': state_dir, 'timeout': timeout}",
        "",
      ].join("\n"),
      "utf8",
    );
    writeJson(devicesPath, { pending: [pending], paired: [paired] });
    try {
      const result = spawnSync("python3", ["-", devicesPath, requestIdPath], {
        encoding: "utf8",
        env: {
          ...process.env,
          NEMOCLAW_OPENCLAW_PAIRING_STATE_HELPER: helperPath,
          OPENCLAW_STATE_DIR: stateRoot,
        },
        input: ADMIN_REQUEST_SELECTOR_PY,
        timeout: 10_000,
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(readFileSync(requestIdPath, "utf8")).toBe(requestId);
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(TOKEN);
    } finally {
      rmSync(fixtureRoot, { force: true, recursive: true });
    }
  });

  it.each(["pending", "paired"] as const)(
    "rejects malformed canonical %s records instead of reporting settled state (#4462)",
    (malformedMap) => {
      const fixtureRoot = mkdtempSync(path.join(tmpdir(), "nemoclaw-issue-4462-malformed-"));
      const stateRoot = path.join(fixtureRoot, "state-root");
      const sqlitePath = path.join(stateRoot, "state", "openclaw.sqlite");
      const helperPath = path.join(fixtureRoot, "openclaw_pairing_state.py");
      const records = {
        identity: {
          deviceId: DEVICE_ID,
          publicKey: PUBLIC_KEY,
        },
        pending: malformedMap === "pending" ? { malformed: TOKEN } : {},
        paired: malformedMap === "paired" ? { malformed: TOKEN } : {},
      };
      mkdirSync(path.dirname(sqlitePath), { recursive: true });
      writeFileSync(sqlitePath, "canonical-layout-sentinel", "utf8");
      writeFileSync(
        helperPath,
        [
          "import json",
          `records = json.loads(${JSON.stringify(JSON.stringify(records))})`,
          "def read_openclaw_pairing_state(state_dir, timeout=1):",
          "    return records, {'stateDir': state_dir, 'timeout': timeout}",
          "",
        ].join("\n"),
        "utf8",
      );
      try {
        const result = spawnSync("python3", [SNAPSHOT_SCRIPT, "0.1", stateRoot, helperPath], {
          encoding: "utf8",
          timeout: 10_000,
        });
        expect(result.status).not.toBe(0);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("canonical pairing state is unavailable");
        expect(`${result.stdout}\n${result.stderr}`).not.toContain(TOKEN);
      } finally {
        rmSync(fixtureRoot, { force: true, recursive: true });
      }
    },
  );

  it("rejects a local CLI identity whose device ID is not bound to its public key (#4462)", () => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), "nemoclaw-issue-4462-binding-"));
    const stateRoot = path.join(fixtureRoot, "state");
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
    try {
      const result = spawnSync("python3", [SNAPSHOT_SCRIPT, "30", stateRoot], {
        encoding: "utf8",
        timeout: 10_000,
      });
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

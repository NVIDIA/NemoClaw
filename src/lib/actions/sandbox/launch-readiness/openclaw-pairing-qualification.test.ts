// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildAutoPairApprovalScript,
  parseAutoPairApprovalReceipt,
  readAutoPairApprovalPolicyModule,
} from "../auto-pair-approval";
import {
  buildOpenClawPairingObservationScript,
  observeOpenClawPairingQualification,
  observeOpenClawPairingRepairSettlement,
  observeOpenClawPairingSettlement,
  observeOrdinaryOpenClawPairingSettlement,
  OPENCLAW_PAIRING_REQUEST_SCOPES,
  OPENCLAW_PAIRING_REQUIRED_SCOPES,
  parseOpenClawPairingObservation,
  parseOpenClawPairingRepairObservation,
  parseOpenClawPairingSettlementObservation,
} from "./openclaw-pairing-qualification";

const TOKEN = "credential-value-must-not-leave-the-sandbox";
const PRIVATE_KEY = "private-key-material-must-not-leave-the-sandbox";
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const PYTHON3_AVAILABLE =
  spawnSync("sh", ["-c", "command -v python3"], { stdio: "ignore" }).status === 0;
type PairedFixture = Record<
  string,
  {
    deviceId: string;
    publicKey: string;
    scopes: string[];
    approvedScopes: string[];
    tokens: { operator: { token: string; scopes: string[] } };
    [key: string]: unknown;
  }
>;
type AuthFixture = { tokens: { operator: { token: string; scopes: string[] } } };
const POLICY = `
ALLOWED_CLIENTS = {'cli', 'openclaw-cli', 'openclaw-control-ui'}
ALLOWED_SCOPES = {'operator.pairing', 'operator.read', 'operator.write'}
def approval_request_decision(device):
    client_id = str(device.get('clientId', ''))
    scopes = device.get('scopes', device.get('requestedScopes', []))
    if not isinstance(scopes, list):
        return {'allowed': False, 'reason': 'malformed-scopes'}
    return {
        'allowed': client_id in ALLOWED_CLIENTS and set(scopes).issubset(ALLOWED_SCOPES),
        'reason': 'allowlisted' if client_id in ALLOWED_CLIENTS else 'unknown-client',
    }
`;

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`, { mode: 0o660 });
  fs.chmodSync(filePath, 0o660);
}

function publicKeyPem(prefix: Buffer, key: Buffer): string {
  return `-----BEGIN PUBLIC KEY-----\n${Buffer.concat([prefix, key]).toString("base64")}\n-----END PUBLIC KEY-----\n`;
}

function localScriptSpawn(
  _binary: string,
  _args: readonly string[],
  options: Parameters<typeof spawnSync>[2],
) {
  const result = spawnSync("sh", ["-s"], {
    ...options,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return result;
}

describe("OpenClaw launch-readiness pairing qualification", () => {
  let root: string;
  let stateDirectory: string;
  let deviceId: string;
  let publicKey: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pairing-qualification-"));
    stateDirectory = path.join(root, ".openclaw");
    fs.mkdirSync(path.join(stateDirectory, "devices"), { mode: 0o2770, recursive: true });
    fs.mkdirSync(path.join(stateDirectory, "identity"), { mode: 0o2770, recursive: true });
    stateDirectory = fs.realpathSync(stateDirectory);
    fs.chmodSync(stateDirectory, 0o2770);
    fs.chmodSync(path.join(stateDirectory, "devices"), 0o2770);
    fs.chmodSync(path.join(stateDirectory, "identity"), 0o2770);
    const publicKeyBytes = Buffer.alloc(32, 7);
    publicKey = publicKeyBytes.toString("base64url");
    deviceId = createHash("sha256").update(publicKeyBytes).digest("hex");
    writeJson(path.join(stateDirectory, "openclaw.json"), {
      gateway: { mode: "local", auth: { token: TOKEN } },
    });
    writeJson(path.join(stateDirectory, "identity", "device.json"), {
      deviceId,
      publicKey,
      privateKeyPem: PRIVATE_KEY,
    });
    writeJson(path.join(stateDirectory, "identity", "device-auth.json"), {
      version: 1,
      deviceId,
      tokens: {
        operator: {
          token: TOKEN,
          role: "operator",
          scopes: [...OPENCLAW_PAIRING_REQUIRED_SCOPES],
        },
      },
    });
    writeJson(path.join(stateDirectory, "devices", "paired.json"), {
      [deviceId]: {
        deviceId,
        publicKey,
        clientId: "cli",
        clientMode: "cli",
        role: "operator",
        roles: ["operator"],
        scopes: [...OPENCLAW_PAIRING_REQUEST_SCOPES],
        approvedScopes: [...OPENCLAW_PAIRING_REQUEST_SCOPES],
        tokens: {
          operator: {
            token: TOKEN,
            role: "operator",
            scopes: [...OPENCLAW_PAIRING_REQUIRED_SCOPES],
          },
        },
      },
    });
    writeJson(path.join(stateDirectory, "devices", "pending.json"), {});
    performance.clearMeasures("nemoclaw.openclaw-pairing.qualification");
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function observe(approvalPolicy = POLICY) {
    return observeOpenClawPairingQualification(
      "alpha",
      "nemoclaw-8080",
      "2026.7.1",
      stateDirectory,
      {
        getOpenshellBinary: () => "openshell",
        readApprovalPolicy: () => approvalPolicy,
        spawnSync: localScriptSpawn as typeof spawnSync,
      },
    );
  }

  function observeSettlement(approvalPolicy = POLICY) {
    return observeOpenClawPairingSettlement("alpha", "nemoclaw-8080", "2026.7.1", stateDirectory, {
      getOpenshellBinary: () => "openshell",
      readApprovalPolicy: () => approvalPolicy,
      spawnSync: localScriptSpawn as typeof spawnSync,
    });
  }

  function observeOrdinarySettlement(approvalPolicy = POLICY) {
    return observeOrdinaryOpenClawPairingSettlement(
      "alpha",
      "nemoclaw-8080",
      "2026.7.1",
      stateDirectory,
      {
        getOpenshellBinary: () => "openshell",
        readApprovalPolicy: () => approvalPolicy,
        spawnSync: localScriptSpawn as typeof spawnSync,
      },
    );
  }

  function observeRepairSettlement(approvalPolicy = POLICY) {
    return observeOpenClawPairingRepairSettlement(
      "alpha",
      "nemoclaw-8080",
      "2026.7.1",
      stateDirectory,
      {
        getOpenshellBinary: () => "openshell",
        readApprovalPolicy: () => approvalPolicy,
        spawnSync: localScriptSpawn as typeof spawnSync,
      },
    );
  }

  function writePairingOnlyState(): void {
    const pairedPath = path.join(stateDirectory, "devices", "paired.json");
    const authPath = path.join(stateDirectory, "identity", "device-auth.json");
    const paired = JSON.parse(fs.readFileSync(pairedPath, "utf8")) as PairedFixture;
    paired[deviceId]!.scopes = ["operator.pairing"];
    paired[deviceId]!.approvedScopes = ["operator.pairing"];
    paired[deviceId]!.tokens.operator.scopes = ["operator.pairing"];
    writeJson(pairedPath, paired);
    const auth = JSON.parse(fs.readFileSync(authPath, "utf8")) as AuthFixture;
    auth.tokens.operator.scopes = ["operator.pairing"];
    writeJson(authPath, auth);
  }

  describe.skipIf(!PYTHON3_AVAILABLE)("state observation", () => {
    it("emits credential-free qualification from canonical settled OpenClaw state (#9023)", () => {
      const qualification = observe();
      const serialized = JSON.stringify(qualification);

      expect(qualification).toMatchObject({
        schemaVersion: 1,
        kind: "openclaw-pairing",
        openclawVersion: "2026.7.1",
        requiredRoles: ["operator"],
        requiredScopes: ["operator.pairing", "operator.read", "operator.write"],
        deviceIdentitySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        pairingStateSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        policySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(serialized).not.toContain(TOKEN);
      expect(serialized).not.toContain(PRIVATE_KEY);
      expect(serialized).not.toContain(publicKey);
      expect(serialized).not.toContain(deviceId);
      expect(performance.getEntriesByName("nemoclaw.openclaw-pairing.qualification")).toHaveLength(
        1,
      );
    });

    it("strictly distinguishes settled and pairing-only state without exposing identity (#9207)", () => {
      const settled = observeSettlement();
      writePairingOnlyState();
      const pairingOnly = observeSettlement();

      expect(settled).toEqual({
        state: "settled",
        deviceIdentitySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(pairingOnly).toEqual({
        state: "pairing-only",
        deviceIdentitySha256: settled.deviceIdentitySha256,
      });
      expect(JSON.stringify([settled, pairingOnly])).not.toContain(TOKEN);
      expect(JSON.stringify([settled, pairingOnly])).not.toContain(deviceId);
      expect(JSON.stringify([settled, pairingOnly])).not.toContain(publicKey);
    });

    it("observes settlement without version provenance but keeps qualification version-bound (#9527)", () => {
      const deps = {
        getOpenshellBinary: () => "openshell",
        readApprovalPolicy: () => POLICY,
        spawnSync: localScriptSpawn as typeof spawnSync,
      };

      expect(
        observeOpenClawPairingSettlement("alpha", "nemoclaw-8080", "", stateDirectory, deps),
      ).toEqual({
        state: "settled",
        deviceIdentitySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(() =>
        observeOpenClawPairingQualification("alpha", "nemoclaw-8080", "", stateDirectory, deps),
      ).toThrow("OpenClaw pairing qualification is unavailable");
    });

    it("accepts the exact canonical Ed25519 public-key PEM representation (#9207)", () => {
      const identityPath = path.join(stateDirectory, "identity", "device.json");
      writeJson(identityPath, {
        deviceId,
        publicKeyPem: publicKeyPem(ED25519_SPKI_PREFIX, Buffer.alloc(32, 7)),
        privateKeyPem: PRIVATE_KEY,
      });

      expect(observeSettlement()).toEqual({
        state: "settled",
        deviceIdentitySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
    });

    it("rejects pending or non-exact scope state from Portable settlement (#9207)", () => {
      writePairingOnlyState();
      writeJson(path.join(stateDirectory, "devices", "pending.json"), {
        "request-1": {
          requestId: "request-1",
          deviceId,
          publicKey,
          clientId: "cli",
          clientMode: "cli",
          role: "operator",
          roles: ["operator"],
          scopes: [...OPENCLAW_PAIRING_REQUEST_SCOPES],
          isRepair: true,
        },
      });
      expect(() => observeSettlement()).toThrow("OpenClaw pairing qualification is unavailable");

      writeJson(path.join(stateDirectory, "devices", "pending.json"), {});
      const pairedPath = path.join(stateDirectory, "devices", "paired.json");
      const paired = JSON.parse(fs.readFileSync(pairedPath, "utf8")) as PairedFixture;
      paired[deviceId]!.scopes = ["operator.pairing", "operator.read"];
      writeJson(pairedPath, paired);
      expect(() => observeSettlement()).toThrow("OpenClaw pairing qualification is unavailable");
    });

    it("rejects unrelated or same-device pending requests during ordinary onboarding (#9844)", () => {
      writeJson(path.join(stateDirectory, "devices", "pending.json"), {
        unrelated: {
          requestId: "unrelated",
          deviceId: "b".repeat(64),
          publicKey: "unrelated-public-key",
          clientId: "unknown-client",
          scopes: ["operator.admin"],
        },
      });

      expect(() => observeOrdinarySettlement()).toThrow(
        "OpenClaw pairing qualification is unavailable",
      );
      expect(() => observeRepairSettlement()).toThrow(
        "OpenClaw pairing qualification is unavailable",
      );
      expect(() => observeSettlement()).toThrow("OpenClaw pairing qualification is unavailable");

      writeJson(path.join(stateDirectory, "devices", "pending.json"), {
        related: {
          requestId: "related",
          deviceId,
          publicKey,
          clientId: "unknown-client",
          scopes: ["operator.admin"],
        },
      });
      expect(() => observeOrdinarySettlement()).toThrow(
        "OpenClaw pairing qualification is unavailable",
      );
      expect(() => observeRepairSettlement()).toThrow(
        "OpenClaw pairing qualification is unavailable",
      );
    });

    it("observes the exact canonical scope upgrade awaiting approval (#9817)", () => {
      writePairingOnlyState();
      writeJson(path.join(stateDirectory, "devices", "pending.json"), {
        "canonical-cli-write": {
          requestId: "canonical-cli-write",
          deviceId,
          publicKey,
          clientId: "cli",
          clientMode: "cli",
          role: "operator",
          roles: ["operator"],
          scopes: ["operator.write"],
          isRepair: true,
        },
      });

      expect(observeOrdinarySettlement()).toEqual({
        state: "scope-upgrade-pending",
        deviceIdentitySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(observeRepairSettlement()).toEqual({
        state: "pairing-pending",
        deviceIdentitySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(() => observeSettlement()).toThrow("OpenClaw pairing qualification is unavailable");

      writeJson(path.join(stateDirectory, "devices", "pending.json"), {
        first: {
          requestId: "first",
          deviceId,
          publicKey,
          clientId: "cli",
          clientMode: "cli",
          role: "operator",
          roles: ["operator"],
          scopes: ["operator.write"],
          isRepair: true,
        },
        second: {
          requestId: "second",
          deviceId: "b".repeat(64),
          publicKey: "unrelated-public-key",
          clientId: "unknown-client",
          scopes: ["operator.admin"],
        },
      });
      expect(() => observeOrdinarySettlement()).toThrow(
        "OpenClaw pairing qualification is unavailable",
      );
      expect(() => observeRepairSettlement()).toThrow(
        "OpenClaw pairing qualification is unavailable",
      );
    });

    it("rejects a non-repair request from Portable repair settlement (#9817)", () => {
      writePairingOnlyState();
      writeJson(path.join(stateDirectory, "devices", "pending.json"), {
        "canonical-cli-write": {
          requestId: "canonical-cli-write",
          deviceId,
          publicKey,
          clientId: "cli",
          clientMode: "cli",
          role: "operator",
          roles: ["operator"],
          scopes: ["operator.write"],
          isRepair: false,
        },
      });

      expect(observeOrdinarySettlement()).toEqual({
        state: "scope-upgrade-pending",
        deviceIdentitySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(() => observeRepairSettlement()).toThrow(
        "OpenClaw pairing qualification is unavailable",
      );
    });

    it("qualifies the persisted result of the complete canonical approval transition (#9023)", () => {
      const approvalPolicy = readAutoPairApprovalPolicyModule();
      expect(approvalPolicy).toBeTruthy();
      const requestId = "canonical-cli-write";
      writeJson(path.join(stateDirectory, "identity", "device-auth.json"), {
        version: 1,
        deviceId,
        tokens: {
          operator: {
            token: TOKEN,
            role: "operator",
            scopes: ["operator.pairing"],
          },
        },
      });
      writeJson(path.join(stateDirectory, "devices", "paired.json"), {
        [deviceId]: {
          deviceId,
          publicKey,
          clientId: "cli",
          clientMode: "cli",
          role: "operator",
          roles: ["operator"],
          scopes: ["operator.pairing"],
          approvedScopes: ["operator.pairing"],
          tokens: {
            operator: {
              token: TOKEN,
              role: "operator",
              scopes: ["operator.pairing"],
            },
          },
        },
      });
      writeJson(path.join(stateDirectory, "devices", "pending.json"), {
        [requestId]: {
          requestId,
          deviceId,
          publicKey,
          clientId: "cli",
          clientMode: "cli",
          role: "operator",
          roles: ["operator"],
          scopes: [...OPENCLAW_PAIRING_REQUEST_SCOPES],
          isRepair: true,
        },
      });
      const openclawPath = path.join(root, "openclaw");
      fs.writeFileSync(
        openclawPath,
        `#!${process.execPath}
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
if (args[0] !== "devices" || args[1] !== "approve") process.exit(2);
const stateDir = process.env.NEMOCLAW_TEST_CLONE_STATE_DIR;
const pendingPath = path.join(stateDir, "devices", "pending.json");
const pairedPath = path.join(stateDir, "devices", "paired.json");
const pending = JSON.parse(fs.readFileSync(pendingPath, "utf8"));
const paired = JSON.parse(fs.readFileSync(pairedPath, "utf8"));
const request = pending[args[2]];
delete pending[args[2]];
paired[request.deviceId] = {
  ...paired[request.deviceId],
  scopes: request.scopes,
  approvedScopes: request.scopes,
  tokens: {
    operator: {
      token: "rotated-canonical-token",
      role: "operator",
      scopes: ["operator.pairing", "operator.read", "operator.write"],
    },
  },
};
fs.writeFileSync(pendingPath, JSON.stringify(pending));
fs.writeFileSync(pairedPath, JSON.stringify(paired));
process.stdout.write("{}\\n");
`,
        { mode: 0o755 },
      );
      const approval = spawnSync("sh", {
        encoding: "utf-8",
        env: {
          ...process.env,
          PATH: `${root}:/usr/bin:/bin`,
          NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING: "1",
          NEMOCLAW_TEST_CLONE_STATE_DIR: stateDirectory,
          OPENCLAW_GATEWAY_PORT: "18789",
          OPENCLAW_GATEWAY_TOKEN: "gateway-token",
          OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:18789",
          OPENCLAW_STATE_DIR: stateDirectory,
        },
        input: buildAutoPairApprovalScript(
          Buffer.from(approvalPolicy as string, "utf8").toString("base64"),
          {
            emitReceipt: true,
            localDeviceOnly: true,
            budget: { maxApprovals: 1 },
          },
        ),
      });

      expect(approval.status).toBe(0);
      expect(parseAutoPairApprovalReceipt(approval.stdout)).toBe("approved-one");
      expect(observe(approvalPolicy as string)).toMatchObject({
        requiredRoles: ["operator"],
        requiredScopes: ["operator.pairing", "operator.read", "operator.write"],
      });
    });

    it("does not make paired credential values part of the receipt identity (#9023)", () => {
      const first = observe();
      const pairedPath = path.join(stateDirectory, "devices", "paired.json");
      const authPath = path.join(stateDirectory, "identity", "device-auth.json");
      const replacementToken = `${TOKEN}-rotated`;
      const paired = JSON.parse(fs.readFileSync(pairedPath, "utf8")) as PairedFixture;
      paired[deviceId]!.tokens.operator.token = replacementToken;
      writeJson(pairedPath, paired);
      const auth = JSON.parse(fs.readFileSync(authPath, "utf8")) as AuthFixture;
      auth.tokens.operator.token = replacementToken;
      writeJson(authPath, auth);

      const second = observe();

      expect(second).toEqual(first);
      expect(JSON.stringify(second)).not.toContain(replacementToken);
    });

    it("does not derive pairing evidence from arbitrary OpenClaw configuration (#9023)", () => {
      const first = observe();
      const credentialValue = `${TOKEN}-arbitrary-config`;
      writeJson(path.join(stateDirectory, "openclaw.json"), {
        unknown: {
          privateKeyPem: credentialValue,
          passwordValue: credentialValue,
          credentialValue,
          headers: { Authorization: `Bearer ${credentialValue}` },
          url: `https://user:${credentialValue}@example.invalid/path?token=${credentialValue}`,
          args: ["run", credentialValue],
        },
      });

      const second = observe();
      const serialized = JSON.stringify(second);

      expect(second).toEqual(first);
      expect(serialized).not.toContain(credentialValue);
    });

    it("rejects a new allowlisted pending request without calling the OpenClaw CLI (#9023)", () => {
      writeJson(path.join(stateDirectory, "devices", "pending.json"), {
        "request-1": {
          requestId: "request-1",
          clientId: "cli",
          clientMode: "cli",
          scopes: ["operator.write"],
        },
      });

      expect(() => observe()).toThrow("OpenClaw pairing qualification is unavailable");
      const script = buildOpenClawPairingObservationScript(
        Buffer.from(POLICY, "utf8").toString("base64"),
        stateDirectory,
      );
      expect(script).not.toContain("openclaw devices list");
      expect(script).not.toContain("[OPENCLAW, 'devices', 'list'");
    });

    it.each([
      [
        "malformed pending state",
        () => writeJson(path.join(stateDirectory, "devices", "pending.json"), []),
      ],
      [
        "unsafe paired permissions",
        () => fs.chmodSync(path.join(stateDirectory, "devices", "paired.json"), 0o666),
      ],
      [
        "world-readable device credentials",
        () => fs.chmodSync(path.join(stateDirectory, "identity", "device-auth.json"), 0o604),
      ],
      [
        "mismatched client credential",
        () => {
          const authPath = path.join(stateDirectory, "identity", "device-auth.json");
          const auth = JSON.parse(fs.readFileSync(authPath, "utf8")) as AuthFixture;
          auth.tokens.operator.token = "different-token";
          writeJson(authPath, auth);
        },
      ],
      [
        "changed paired request scopes",
        () => {
          const pairedPath = path.join(stateDirectory, "devices", "paired.json");
          const paired = JSON.parse(fs.readFileSync(pairedPath, "utf8")) as PairedFixture;
          paired[deviceId]!.scopes = ["operator.pairing", "operator.read", "operator.write"];
          writeJson(pairedPath, paired);
        },
      ],
      [
        "changed approved request scopes",
        () => {
          const pairedPath = path.join(stateDirectory, "devices", "paired.json");
          const paired = JSON.parse(fs.readFileSync(pairedPath, "utf8")) as PairedFixture;
          paired[deviceId]!.approvedScopes = ["operator.pairing", "operator.read"];
          writeJson(pairedPath, paired);
        },
      ],
      [
        "changed paired token scopes",
        () => {
          const pairedPath = path.join(stateDirectory, "devices", "paired.json");
          const paired = JSON.parse(fs.readFileSync(pairedPath, "utf8")) as PairedFixture;
          paired[deviceId]!.tokens.operator.scopes = ["operator.pairing", "operator.write"];
          writeJson(pairedPath, paired);
        },
      ],
      [
        "changed client-auth token scopes",
        () => {
          const authPath = path.join(stateDirectory, "identity", "device-auth.json");
          const auth = JSON.parse(fs.readFileSync(authPath, "utf8")) as AuthFixture;
          auth.tokens.operator.scopes = ["operator.pairing", "operator.write"];
          writeJson(authPath, auth);
        },
      ],
      [
        "changed canonical client ID",
        () => {
          const pairedPath = path.join(stateDirectory, "devices", "paired.json");
          const paired = JSON.parse(fs.readFileSync(pairedPath, "utf8")) as PairedFixture;
          paired[deviceId]!.clientId = "unknown-client";
          writeJson(pairedPath, paired);
        },
      ],
      [
        "changed canonical client mode",
        () => {
          const pairedPath = path.join(stateDirectory, "devices", "paired.json");
          const paired = JSON.parse(fs.readFileSync(pairedPath, "utf8")) as PairedFixture;
          paired[deviceId]!.clientMode = "unknown-mode";
          writeJson(pairedPath, paired);
        },
      ],
      [
        "duplicate operator identity roles",
        () => {
          const pairedPath = path.join(stateDirectory, "devices", "paired.json");
          const paired = JSON.parse(fs.readFileSync(pairedPath, "utf8")) as PairedFixture;
          paired[deviceId]!.roles = ["operator", "operator"];
          writeJson(pairedPath, paired);
        },
      ],
      [
        "missing canonical operator role",
        () => {
          const pairedPath = path.join(stateDirectory, "devices", "paired.json");
          const paired = JSON.parse(fs.readFileSync(pairedPath, "utf8")) as PairedFixture;
          delete (paired[deviceId]! as unknown as Record<string, unknown>).role;
          writeJson(pairedPath, paired);
        },
      ],
      [
        "missing canonical operator roles",
        () => {
          const pairedPath = path.join(stateDirectory, "devices", "paired.json");
          const paired = JSON.parse(fs.readFileSync(pairedPath, "utf8")) as PairedFixture;
          delete (paired[deviceId]! as unknown as Record<string, unknown>).roles;
          writeJson(pairedPath, paired);
        },
      ],
      [
        "conflicting device public-key representations",
        () => {
          const identityPath = path.join(stateDirectory, "identity", "device.json");
          const identity = JSON.parse(fs.readFileSync(identityPath, "utf8")) as Record<
            string,
            unknown
          >;
          identity.publicKeyPem = publicKeyPem(ED25519_SPKI_PREFIX, Buffer.alloc(32, 8));
          writeJson(identityPath, identity);
        },
      ],
      [
        "malformed public-key PEM with a matching suffix",
        () => {
          const identityPath = path.join(stateDirectory, "identity", "device.json");
          const identity = JSON.parse(fs.readFileSync(identityPath, "utf8")) as Record<
            string,
            unknown
          >;
          identity.publicKeyPem = publicKeyPem(Buffer.alloc(12), Buffer.alloc(32, 7));
          writeJson(identityPath, identity);
        },
      ],
      [
        "noncanonical padded raw public key",
        () => {
          const identityPath = path.join(stateDirectory, "identity", "device.json");
          const identity = JSON.parse(fs.readFileSync(identityPath, "utf8")) as Record<
            string,
            unknown
          >;
          identity.publicKey = `${publicKey}=`;
          writeJson(identityPath, identity);
          const pairedPath = path.join(stateDirectory, "devices", "paired.json");
          const paired = JSON.parse(fs.readFileSync(pairedPath, "utf8")) as PairedFixture;
          paired[deviceId]!.publicKey = `${publicKey}=`;
          writeJson(pairedPath, paired);
        },
      ],
      [
        "whitespace-padded operator token",
        () => {
          const pairedPath = path.join(stateDirectory, "devices", "paired.json");
          const paired = JSON.parse(fs.readFileSync(pairedPath, "utf8")) as PairedFixture;
          paired[deviceId]!.tokens.operator.token = ` ${TOKEN} `;
          writeJson(pairedPath, paired);
          const authPath = path.join(stateDirectory, "identity", "device-auth.json");
          const auth = JSON.parse(fs.readFileSync(authPath, "utf8")) as AuthFixture;
          auth.tokens.operator.token = ` ${TOKEN} `;
          writeJson(authPath, auth);
        },
      ],
      [
        "boolean client-auth schema version",
        () => {
          const authPath = path.join(stateDirectory, "identity", "device-auth.json");
          const auth = JSON.parse(fs.readFileSync(authPath, "utf8")) as AuthFixture & {
            version?: unknown;
          };
          auth.version = true;
          writeJson(authPath, auth);
        },
      ],
      [
        "alternate scopes on the paired device",
        () => {
          const pairedPath = path.join(stateDirectory, "devices", "paired.json");
          const paired = JSON.parse(fs.readFileSync(pairedPath, "utf8")) as PairedFixture;
          paired[deviceId]!.requestedScopes = ["operator.admin"];
          writeJson(pairedPath, paired);
        },
      ],
      [
        "alternate public key on the paired device",
        () => {
          const pairedPath = path.join(stateDirectory, "devices", "paired.json");
          const paired = JSON.parse(fs.readFileSync(pairedPath, "utf8")) as PairedFixture;
          paired[deviceId]!.publicKeyPem = publicKeyPem(ED25519_SPKI_PREFIX, Buffer.alloc(32, 8));
          writeJson(pairedPath, paired);
        },
      ],
      [
        "alternate roles on the paired operator token",
        () => {
          const pairedPath = path.join(stateDirectory, "devices", "paired.json");
          const paired = JSON.parse(fs.readFileSync(pairedPath, "utf8")) as PairedFixture;
          (paired[deviceId]!.tokens.operator as unknown as Record<string, unknown>).roles = [
            "admin",
          ];
          writeJson(pairedPath, paired);
        },
      ],
      [
        "alternate scopes on the client authorization",
        () => {
          const authPath = path.join(stateDirectory, "identity", "device-auth.json");
          const auth = JSON.parse(fs.readFileSync(authPath, "utf8")) as AuthFixture;
          (auth.tokens.operator as unknown as Record<string, unknown>).approvedScopes = [
            "operator.admin",
          ];
          writeJson(authPath, auth);
        },
      ],
      [
        "ambiguous local device state",
        () => {
          const pairedPath = path.join(stateDirectory, "devices", "paired.json");
          const paired = JSON.parse(fs.readFileSync(pairedPath, "utf8")) as PairedFixture;
          paired.duplicate = { ...paired[deviceId]!, deviceId: "different-device" };
          writeJson(pairedPath, paired);
        },
      ],
    ])("rejects %s and requires the complete pairing path (#9023)", (_label, mutate) => {
      expect(() => observe()).not.toThrow();
      mutate();
      expect(() => observe()).toThrow("OpenClaw pairing qualification is unavailable");
    });
  });

  it("pins observation to the named gateway and rejects non-terminal output (#9023)", () => {
    const digest = "a".repeat(64);
    const spawn = vi.fn(
      (_binary: string, _args: readonly string[], _options: Parameters<typeof spawnSync>[2]) => ({
        status: 0,
        signal: null,
        stdout: `__NEMOCLAW_OPENCLAW_PAIRING_QUALIFICATION__=${JSON.stringify({
          deviceIdentitySha256: digest,
          pairingStateSha256: digest,
          requiredRoles: ["operator"],
          requiredScopes: ["operator.pairing", "operator.read", "operator.write"],
        })}\nuntrusted trailing output\n`,
        stderr: "",
      }),
    );

    expect(() =>
      observeOpenClawPairingQualification("alpha", "nemoclaw-8080", "2026.7.1", stateDirectory, {
        getOpenshellBinary: () => "openshell",
        readApprovalPolicy: () => POLICY,
        spawnSync: spawn as never,
      }),
    ).toThrow("OpenClaw pairing qualification is unavailable");
    expect(spawn.mock.calls[0]?.[1]).toEqual([
      "sandbox",
      "exec",
      "--name",
      "alpha",
      "-g",
      "nemoclaw-8080",
      "--",
      "sh",
      "-s",
    ]);
    expect(spawn.mock.calls[0]?.[2]).toMatchObject({
      maxBuffer: 4 * 1_024,
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 3_000,
    });
  });

  it("transports state paths without shell interpretation (#9023)", () => {
    const rawStateDirectory = "/sandbox/state'$(touch should-not-run)";
    const script = buildOpenClawPairingObservationScript(
      Buffer.from(POLICY, "utf8").toString("base64"),
      rawStateDirectory,
    );

    expect(script).not.toContain(rawStateDirectory);
    expect(script).toContain(Buffer.from(rawStateDirectory, "utf8").toString("base64"));
  });

  it("rejects extra receipt fields that could carry unrestricted state (#9023)", () => {
    const digest = "a".repeat(64);
    const output = `__NEMOCLAW_OPENCLAW_PAIRING_QUALIFICATION__=${JSON.stringify({
      deviceIdentitySha256: digest,
      pairingStateSha256: digest,
      requiredRoles: ["operator"],
      requiredScopes: ["operator.pairing", "operator.read", "operator.write"],
      token: TOKEN,
    })}\n`;

    expect(parseOpenClawPairingObservation(output)).toBeNull();
  });

  it("rejects non-terminal or expanded Portable settlement output (#9207)", () => {
    const digest = "a".repeat(64);
    const output = `__NEMOCLAW_OPENCLAW_PAIRING_SETTLEMENT__=${JSON.stringify({
      state: "settled",
      deviceIdentitySha256: digest,
      requestId: "secret-request",
    })}\n`;
    expect(parseOpenClawPairingSettlementObservation(output)).toBeNull();
    expect(
      parseOpenClawPairingSettlementObservation(
        `__NEMOCLAW_OPENCLAW_PAIRING_SETTLEMENT__=${JSON.stringify({
          state: "settled",
          deviceIdentitySha256: digest,
        })}\ntrailing\n`,
      ),
    ).toBeNull();
  });

  it("keeps canonical pending state outside strict Portable settlement (#9817)", () => {
    const digest = "a".repeat(64);
    const output = `__NEMOCLAW_OPENCLAW_PAIRING_SETTLEMENT__=${JSON.stringify({
      state: "pairing-pending",
      deviceIdentitySha256: digest,
    })}\n`;

    expect(parseOpenClawPairingRepairObservation(output)).toEqual({
      state: "pairing-pending",
      deviceIdentitySha256: digest,
    });
    expect(parseOpenClawPairingSettlementObservation(output)).toBeNull();
  });
});

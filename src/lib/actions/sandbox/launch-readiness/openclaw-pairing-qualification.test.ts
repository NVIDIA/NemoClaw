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
  buildOpenClawPairingObservationScript,
  observeOpenClawPairingQualification,
  OPENCLAW_PAIRING_REQUIRED_SCOPES,
  parseOpenClawPairingObservation,
} from "./openclaw-pairing-qualification";

const TOKEN = "credential-value-must-not-leave-the-sandbox";
const PRIVATE_KEY = "private-key-material-must-not-leave-the-sandbox";
const PYTHON3_AVAILABLE =
  spawnSync("sh", ["-c", "command -v python3"], { stdio: "ignore" }).status === 0;
type PairedFixture = Record<
  string,
  {
    deviceId: string;
    publicKey: string;
    approvedScopes: string[];
    tokens: { operator: { token: string } };
    [key: string]: unknown;
  }
>;
type AuthFixture = { tokens: { operator: { token: string } } };
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
        scopes: [...OPENCLAW_PAIRING_REQUIRED_SCOPES],
        approvedScopes: [...OPENCLAW_PAIRING_REQUIRED_SCOPES],
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

  function observe() {
    return observeOpenClawPairingQualification(
      "alpha",
      "nemoclaw-8080",
      "2026.7.1",
      stateDirectory,
      {
        getOpenshellBinary: () => "openshell",
        readApprovalPolicy: () => POLICY,
        spawnSync: localScriptSpawn as typeof spawnSync,
      },
    );
  }

  describe.skipIf(!PYTHON3_AVAILABLE)("state observation", () => {
    it("emits a credential-free qualification from supported shared OpenClaw state (#9023)", () => {
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
        "incomplete required scopes",
        () => {
          const pairedPath = path.join(stateDirectory, "devices", "paired.json");
          const paired = JSON.parse(fs.readFileSync(pairedPath, "utf8")) as PairedFixture;
          paired[deviceId]!.approvedScopes = ["operator.pairing", "operator.read"];
          writeJson(pairedPath, paired);
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
        "ambiguous local device state",
        () => {
          const pairedPath = path.join(stateDirectory, "devices", "paired.json");
          const paired = JSON.parse(fs.readFileSync(pairedPath, "utf8")) as PairedFixture;
          paired.duplicate = { ...paired[deviceId]!, deviceId: "different-device" };
          writeJson(pairedPath, paired);
        },
      ],
    ])("rejects %s and requires the complete pairing path (#9023)", (_label, mutate) => {
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
});

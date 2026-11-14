// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { createOpenClawPairingFixture } from "../../../../test/helpers/openclaw-pairing-fixture";
import { entry } from "../../../../test/helpers/native-launch-readiness";
import { loadAgent } from "../../agent/defs";
import type {
  LaunchReadinessFence,
  LaunchReadinessIdentity,
  LaunchReadinessLease,
} from "../../state/launch-readiness-lease";
import { readAutoPairApprovalPolicyModule } from "./auto-pair-approval";
import {
  observeOpenClawPairingQualification,
  OPENCLAW_PAIRING_REQUEST_SCOPES,
  OPENCLAW_PAIRING_REQUIRED_SCOPES,
} from "./launch-readiness/openclaw-pairing-qualification";
import {
  inspectLaunchReadiness,
  publishLaunchReadiness,
  publicationFromDecision,
  type LaunchReadinessDeps,
} from "./launch-readiness";

const SANDBOX = "alpha";
const GATEWAY_NAME = "nemoclaw";
const GATEWAY_PORT = 8080;
const EPOCH = "a".repeat(64);

const POLICY_A = `version: 1
network_policies:
  public_api:
    name: Public API
    endpoints:
      - host: example.com
        port: 443
    binaries:
      - path: /usr/bin/curl
`;

function fence(): LaunchReadinessFence {
  return {
    schemaVersion: 3,
    kind: "fence",
    epochId: EPOCH,
    sandboxName: SANDBOX,
    fencedWallMs: 1,
    fencedUptimeMs: 1,
    bootId: "boot-a",
    uid: 1,
    homeDevice: "1",
    homeInode: "2",
    storeDevice: "1",
    storeInode: "3",
    gatewayName: GATEWAY_NAME,
    gatewayPort: GATEWAY_PORT,
    publicationState: "ready",
    preservedLeaseStartedWallMs: null,
    preservedLeaseExpiresWallMs: null,
    preservedLeaseElapsedMs: null,
  };
}

function lease(identity: LaunchReadinessIdentity): LaunchReadinessLease {
  return {
    schemaVersion: 3,
    kind: "lease",
    epochId: EPOCH,
    sandboxName: SANDBOX,
    leaseStartedWallMs: 1,
    leaseExpiresWallMs: 86_400_001,
    elapsedAtPublicationMs: 0,
    publishedWallMs: 1,
    publishedUptimeMs: 1,
    bootId: "boot-a",
    uid: 1,
    homeDevice: "1",
    homeInode: "2",
    storeDevice: "1",
    storeInode: "3",
    gatewayName: GATEWAY_NAME,
    gatewayPort: GATEWAY_PORT,
    identity,
  };
}

const TUI_SCOPES = ["operator.admin", "operator.approvals", "operator.read", "operator.write"];

it.each([
  {
    profile: "CLI pairing/write",
    clientId: "cli",
    initialMode: "cli",
    scopes: OPENCLAW_PAIRING_REQUEST_SCOPES,
    tokenScopes: OPENCLAW_PAIRING_REQUIRED_SCOPES,
    nextMode: "probe",
    finalMode: "cli",
  },
  {
    profile: "CLI explicit read",
    clientId: "cli",
    initialMode: "cli",
    scopes: OPENCLAW_PAIRING_REQUIRED_SCOPES,
    tokenScopes: OPENCLAW_PAIRING_REQUIRED_SCOPES,
    nextMode: "probe",
    finalMode: "cli",
  },
  {
    profile: "native TUI",
    clientId: "openclaw-tui",
    initialMode: "ui",
    scopes: TUI_SCOPES,
    tokenScopes: TUI_SCOPES,
    nextMode: "ui",
    finalMode: "ui",
  },
])(
  "keeps a published $profile lease accepted until its pairing state changes (#13100, #13668)",
  async ({ clientId, initialMode, scopes, tokenScopes, nextMode, finalMode }) => {
    const fixture = createOpenClawPairingFixture();
    try {
      const pairedPath = path.join(fixture.stateDirectory, "devices", "paired.json");
      const paired = JSON.parse(fs.readFileSync(pairedPath, "utf8"));
      paired[fixture.deviceId].clientId = clientId;
      paired[fixture.deviceId].clientMode = initialMode;
      paired[fixture.deviceId].scopes = [...scopes];
      paired[fixture.deviceId].approvedScopes = [...scopes];
      paired[fixture.deviceId].tokens.operator.scopes = [...tokenScopes];
      fs.writeFileSync(pairedPath, JSON.stringify(paired));
      const authPath = path.join(fixture.stateDirectory, "identity", "device-auth.json");
      const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
      auth.tokens.operator.scopes = [...tokenScopes];
      fs.writeFileSync(authPath, JSON.stringify(auth));
      let published: LaunchReadinessLease | null = null;
      const deps: LaunchReadinessDeps = {
        getSandbox: () => entry(),
        listAgents: () => ["openclaw"],
        loadAgent,
        observeSandbox: () => ({ state: "ready", liveIdentityFingerprint: "b".repeat(64) }),
        capture: (args) => {
          const output =
            args[0] === "policy" ? POLICY_A : "Gateway Inference:\n\n  Not configured\n";
          return { status: 0, output, stdout: output, stderr: "" };
        },
        gatewayHealth: async () => true,
        forwardsHealthy: () => true,
        smoke: async () => ({ ok: true }),
        inferenceProbe: async () => ({
          healthy: true,
          broken: false,
          httpStatus: 200,
          detail: "OK 200",
        }),
        observeOpenClawPairingQualification: (name, gateway, version) =>
          observeOpenClawPairingQualification(name, gateway, version, fixture.stateDirectory, {
            getOpenshellBinary: () => "openshell",
            readApprovalPolicy: readAutoPairApprovalPolicyModule,
            spawnSync: ((_binary, _args, options) =>
              spawnSync("sh", ["-s"], options)) as typeof spawnSync,
          }),
        classifyPortableLifecycleReceipt: () => ({ kind: "absent" }),
        readLease: () => (published ? { kind: "valid", lease: published } : { kind: "missing" }),
        fenceLease: () => fence(),
        publishLease: (_name, _gateway, _port, _epoch, identity) => {
          published = lease(identity);
          return published;
        },
        withSandboxLock: async (_name, operation) => operation(),
        withGatewayLock: async (_name, operation) => operation(),
      };
      const initial = await inspectLaunchReadiness(SANDBOX, deps);
      expect(await publishLaunchReadiness(publicationFromDecision(SANDBOX, initial), deps)).toEqual(
        { kind: "published" },
      );
      paired[fixture.deviceId].clientMode = nextMode;
      fs.writeFileSync(pairedPath, JSON.stringify(paired));
      expect(await inspectLaunchReadiness(SANDBOX, deps)).toMatchObject({ kind: "accepted" });
      paired[fixture.deviceId].clientMode = finalMode;
      fs.writeFileSync(pairedPath, JSON.stringify(paired));
      expect(await inspectLaunchReadiness(SANDBOX, deps)).toMatchObject({ kind: "accepted" });
      paired[fixture.deviceId].tokens.operator.revokedAtMs = 1;
      fs.writeFileSync(pairedPath, JSON.stringify(paired));
      expect(await inspectLaunchReadiness(SANDBOX, deps)).toMatchObject({
        kind: "fallback",
        category: "session",
      });
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  },
);

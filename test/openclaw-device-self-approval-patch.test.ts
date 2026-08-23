// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  openPatchedPairingFixture,
  runFixture,
  runPatch,
  selfApprovalOptions,
  selfApprovalTransactionJournal as transactionJournal,
  selfApprovalTransactionSnapshots as transactionSnapshots,
  validClient,
  validPaired,
  validPending,
  writeFixtureDist,
} from "./helpers/openclaw-device-self-approval-patch-harness";

interface CliFixtureRuntime {
  gatewayCalls: Array<Record<string, unknown>>;
  setPairingLists(local: Record<string, unknown>, live?: Record<string, unknown>): void;
  setPairedTokenEnvironment(overrides?: Record<string, unknown>): void;
  setGatewayListFailure(error: Error): void;
  setApprovalFailures(errors: Error[]): void;
  pairingStats(): { localPairingReadCount: number; localApprovalCount: number };
  pairingDescriptorReads(): Array<{ fd: number; position: number }>;
  approvePairingWithFallback(opts: Record<string, unknown>, requestId: string): Promise<unknown>;
}

function openPatchedCliFixture(): { runtime: CliFixtureRuntime; tmp: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-device-cli-runtime-"));
  const dist = path.join(tmp, "dist");
  fs.mkdirSync(dist);
  writeFixtureDist(dist);
  const apply = runPatch(dist);
  expect(apply.status, "OpenClaw CLI fixture patch failed").toBe(0);
  const source = fs.readFileSync(path.join(dist, "devices-cli.runtime-fixture.js"), "utf8");
  const runtime = runFixture<CliFixtureRuntime>(
    source,
    `({
      gatewayCalls,
      setPairingLists,
      setPairedTokenEnvironment,
      setGatewayListFailure,
      setApprovalFailures,
      pairingStats,
      pairingDescriptorReads,
      approvePairingWithFallback
    })`,
  );
  return { runtime, tmp };
}

function clonePairedTokenRecord(token: string, overrides: Record<string, unknown> = {}) {
  return validPaired({
    tokens: {
      operator: { token, role: "operator", scopes: ["operator.pairing"] },
    },
    ...overrides,
  });
}

describe("OpenClaw bounded device self-approval patch (#4462)", () => {
  it("applies and audits each reviewed CLI, gateway, and canonical-state target", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-device-self-approval-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist);
    writeFixtureDist(dist);
    try {
      const freshAudit = runPatch(dist, true);
      expect(freshAudit.status, `${freshAudit.stdout}${freshAudit.stderr}`).toBe(0);
      expect(freshAudit.stdout).toContain("6 OK · 0 missing");
      expect(freshAudit.stdout).toContain("would-apply");

      const apply = runPatch(dist);
      expect(apply.status, `${apply.stdout}${apply.stderr}`).toBe(0);
      const appliedAudit = runPatch(dist, true);
      expect(appliedAudit.status, `${appliedAudit.stdout}${appliedAudit.stderr}`).toBe(0);
      expect(appliedAudit.stdout.match(/already-applied/gu)).toHaveLength(6);

      const secondApply = runPatch(dist);
      expect(secondApply.status, `${secondApply.stdout}${secondApply.stderr}`).toBe(0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("retains a stored CLI identity while preserving bootstrap and backend shared auth", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-device-identity-bootstrap-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist);
    writeFixtureDist(dist);
    try {
      expect(runPatch(dist).status).toBe(0);
      const source = fs.readFileSync(path.join(dist, "call-fixture.js"), "utf8");
      const runtime = runFixture<{
        setForceDevicePairing(value: boolean): void;
        setStoredOperatorDeviceAuthToken(value: boolean): void;
        shouldOmitDeviceIdentityForGatewayCall(params: Record<string, unknown>): boolean;
      }>(
        source,
        "({ setForceDevicePairing, setStoredOperatorDeviceAuthToken, shouldOmitDeviceIdentityForGatewayCall })",
      );
      const cliParams = {
        authMode: "token",
        opts: { clientName: "cli", mode: "cli" },
        token: "loopback-token",
        url: "ws://127.0.0.1:18789",
      };
      const backendParams = {
        authMode: "token",
        opts: { clientName: "gateway-client", mode: "backend" },
        token: "loopback-token",
        url: "ws://127.0.0.1:18789",
      };

      expect(runtime.shouldOmitDeviceIdentityForGatewayCall(cliParams)).toBe(true);
      runtime.setForceDevicePairing(true);
      expect(runtime.shouldOmitDeviceIdentityForGatewayCall(cliParams)).toBe(false);
      runtime.setForceDevicePairing(false);
      runtime.setStoredOperatorDeviceAuthToken(true);
      expect(runtime.shouldOmitDeviceIdentityForGatewayCall(cliParams)).toBe(false);
      runtime.setStoredOperatorDeviceAuthToken(false);
      expect(runtime.shouldOmitDeviceIdentityForGatewayCall(cliParams)).toBe(true);
      expect(runtime.shouldOmitDeviceIdentityForGatewayCall(backendParams)).toBe(true);
      expect(
        runtime.shouldOmitDeviceIdentityForGatewayCall({
          ...backendParams,
          url: "wss://gateway.example.test",
        }),
      ).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("disables pathname-backed stored auth only for forced paired-token calls", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-device-forced-auth-deps-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist);
    writeFixtureDist(dist);
    try {
      expect(runPatch(dist).status).toBe(0);
      const source = fs.readFileSync(path.join(dist, "call-fixture.js"), "utf8");
      const runtime = runFixture<{
        gatewayClientOptions(opts: Record<string, unknown>): Promise<{
          hostDeps?: {
            clearDeviceAuthToken(): void;
            loadDeviceAuthToken(): unknown;
            storeDeviceAuthToken(): void;
          };
        }>;
      }>(source, "({ gatewayClientOptions })");

      const ordinary = await runtime.gatewayClientOptions({ url: "ws://127.0.0.1:18789" });
      expect(ordinary).not.toHaveProperty("hostDeps");

      const forced = await runtime.gatewayClientOptions({
        nemoclawDisableStoredDeviceAuth: true,
        url: "ws://127.0.0.1:18789",
      });
      expect(forced.hostDeps?.loadDeviceAuthToken()).toBeNull();
      expect(() => forced.hostDeps?.storeDeviceAuthToken()).not.toThrow();
      expect(() => forced.hostDeps?.clearDeviceAuthToken()).not.toThrow();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("loads only the expected forced clone identity for gateway calls", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-device-expected-identity-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist);
    writeFixtureDist(dist);
    try {
      expect(runPatch(dist).status).toBe(0);
      const source = fs.readFileSync(path.join(dist, "call-fixture.js"), "utf8");
      const runtime = runFixture<{
        setForcedDeviceIdentity(identity: unknown, expectedDeviceId?: string): void;
        resolveDeviceIdentityForGatewayCall(): { deviceId: string };
        getDeviceIdentityLoadCount(): number;
      }>(
        source,
        "({ setForcedDeviceIdentity, resolveDeviceIdentityForGatewayCall, getDeviceIdentityLoadCount })",
      );

      runtime.setForcedDeviceIdentity({ deviceId: "clone-device" }, "clone-device");
      expect(runtime.resolveDeviceIdentityForGatewayCall()).toEqual({ deviceId: "clone-device" });
      expect(runtime.getDeviceIdentityLoadCount()).toBe(1);

      runtime.setForcedDeviceIdentity({ deviceId: "primary-device" }, "clone-device");
      expect(() => runtime.resolveDeviceIdentityForGatewayCall()).toThrow(
        "forced pairing device identity does not match the clone",
      );
      runtime.setForcedDeviceIdentity({ deviceId: "clone-device" });
      expect(() => runtime.resolveDeviceIdentityForGatewayCall()).toThrow(
        "forced pairing expected device identity is unavailable",
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("keeps ordinary forced pairing on the default identity path", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-device-ordinary-identity-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist);
    writeFixtureDist(dist);
    try {
      expect(runPatch(dist).status).toBe(0);
      const source = fs.readFileSync(path.join(dist, "call-fixture.js"), "utf8");
      const runtime = runFixture<{
        setForceDevicePairing(value: boolean): void;
        resolveDeviceIdentityForGatewayCall(): { deviceId: string };
        getDeviceIdentityLoadCount(): number;
      }>(
        source,
        "({ setForceDevicePairing, resolveDeviceIdentityForGatewayCall, getDeviceIdentityLoadCount })",
      );

      runtime.setForceDevicePairing(true);

      expect(runtime.resolveDeviceIdentityForGatewayCall()).toEqual({ deviceId: "device-1" });
      expect(runtime.getDeviceIdentityLoadCount()).toBe(1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("reads the forced identity descriptor from position zero without creating or migrating", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-device-identity-fd-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist);
    writeFixtureDist(dist);
    try {
      expect(runPatch(dist).status).toBe(0);
      const source = fs.readFileSync(path.join(dist, "device-identity-fixture.js"), "utf8");
      const runtime = runFixture<{
        setForcedIdentityDescriptor(fd: string | undefined, value: unknown): void;
        clearForcedIdentityDescriptor(): void;
        loadOrCreateDeviceIdentity(): { deviceId: string };
        identityStats(): {
          descriptorReads: Array<{ fd: number; position: number }>;
          ordinaryLoadCount: number;
          defaultPathResolveCount: number;
        };
      }>(
        source,
        "({ setForcedIdentityDescriptor, clearForcedIdentityDescriptor, loadOrCreateDeviceIdentity, identityStats })",
      );
      const storedIdentity = {
        version: 1,
        validForReadOnly: true,
        deviceId: "clone-device",
        publicKeyPem: "clone-public-key",
        privateKeyPem: "clone-private-key",
      };
      runtime.setForcedIdentityDescriptor("43", storedIdentity);

      expect(runtime.loadOrCreateDeviceIdentity()).toMatchObject({ deviceId: "clone-device" });
      expect(runtime.loadOrCreateDeviceIdentity()).toMatchObject({ deviceId: "clone-device" });
      expect(runtime.identityStats()).toEqual({
        descriptorReads: [
          { fd: 43, position: 0 },
          { fd: 43, position: 0 },
        ],
        ordinaryLoadCount: 0,
        defaultPathResolveCount: 0,
      });

      runtime.clearForcedIdentityDescriptor();
      expect(runtime.loadOrCreateDeviceIdentity()).toMatchObject({ deviceId: "ordinary-device" });
      expect(runtime.identityStats().ordinaryLoadCount).toBe(1);
      expect(runtime.identityStats().defaultPathResolveCount).toBe(1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it.each([
    ["a missing descriptor", undefined, undefined],
    ["a non-canonical descriptor", "043", {}],
    ["malformed JSON", "43", "{"],
    ["an invalid stored identity", "43", { version: 1, validForReadOnly: false }],
  ])("fails closed on %s without entering the ordinary identity creator", (_label, fd, value) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-device-invalid-identity-fd-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist);
    writeFixtureDist(dist);
    try {
      expect(runPatch(dist).status).toBe(0);
      const source = fs.readFileSync(path.join(dist, "device-identity-fixture.js"), "utf8");
      const runtime = runFixture<{
        setForcedIdentityDescriptor(fd: string | undefined, value: unknown): void;
        loadOrCreateDeviceIdentity(): unknown;
        identityStats(): { ordinaryLoadCount: number; defaultPathResolveCount: number };
      }>(source, "({ setForcedIdentityDescriptor, loadOrCreateDeviceIdentity, identityStats })");
      runtime.setForcedIdentityDescriptor(fd, value);

      expect(() => runtime.loadOrCreateDeviceIdentity()).toThrow(
        /forced pairing identity descriptor/iu,
      );
      expect(runtime.identityStats().ordinaryLoadCount).toBe(0);
      expect(runtime.identityStats().defaultPathResolveCount).toBe(0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("upgrades a force-only patched local base with stored-device identity retention", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-device-identity-upgrade-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist);
    writeFixtureDist(dist);
    try {
      const callFile = path.join(dist, "call-fixture.js");
      const source = fs.readFileSync(callFile, "utf8");
      const target = [
        "function shouldOmitDeviceIdentityForGatewayCall(params) {",
        "\tconst mode = params.opts.mode ?? GATEWAY_CLIENT_MODES.CLI;",
      ].join("\n");
      const forceOnly = [
        "function shouldOmitDeviceIdentityForGatewayCall(params) {",
        '\tif (process.env.NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING === "1") return false; // nemoclaw: force device identity for loopback pairing bootstrap (#4462)',
        "\tconst mode = params.opts.mode ?? GATEWAY_CLIENT_MODES.CLI;",
      ].join("\n");
      expect(source).toContain(target);
      fs.writeFileSync(callFile, source.replace(target, forceOnly));

      const apply = runPatch(dist);
      expect(apply.status, `${apply.stdout}${apply.stderr}`).toBe(0);
      const patched = fs.readFileSync(callFile, "utf8");
      expect(patched.match(/force device identity for loopback pairing bootstrap/gu)).toHaveLength(
        1,
      );
      expect(
        patched.match(
          /retain stored CLI device identity for loopback shared-token scope enforcement/gu,
        ),
      ).toHaveLength(1);
      expect(runPatch(dist).status).toBe(0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it.each([
    { client: { id: "control-ui", mode: "ui" }, role: "operator", scopes: ["operator.write"] },
    { client: { id: "cli", mode: "cli" }, role: "node", scopes: ["operator.write"] },
    { client: { id: "cli", mode: "cli" }, role: "operator", scopes: ["operator.admin"] },
    {
      client: { id: "cli", mode: "cli" },
      role: "operator",
      scopes: ["operator.write", "operator.write"],
    },
  ])(
    "routes only a bounded CLI device-token scope mismatch into canonical pairing [case %#]",
    async (candidate) => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-device-auth-upgrade-"));
      const dist = path.join(tmp, "dist");
      fs.mkdirSync(dist);
      writeFixtureDist(dist);
      try {
        expect(runPatch(dist).status).toBe(0);
        const source = fs.readFileSync(path.join(dist, "message-handler-fixture.js"), "utf8");
        const connect = runFixture<
          (
            params: Record<string, unknown>,
            verify: () => Promise<Record<string, unknown>>,
          ) => Promise<Record<string, unknown>>
        >(source, "connect");
        const scopeMismatch = async () => ({ ok: false, reason: "scope_mismatch" });
        await expect(
          connect(
            { client: { id: "cli", mode: "cli" }, role: "operator", scopes: ["operator.write"] },
            scopeMismatch,
          ),
        ).resolves.toMatchObject({ authOk: true, authMethod: "device-token" });

        await expect(connect(candidate, scopeMismatch)).resolves.toMatchObject({ authOk: false });

        await expect(
          connect(
            { client: { id: "cli", mode: "cli" }, role: "operator", scopes: ["operator.write"] },
            async () => ({ ok: false, reason: "token-mismatch" }),
          ),
        ).resolves.toMatchObject({ authOk: false });
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  );

  it("uses only operator.pairing to reach the gateway for the exact complete CLI shape", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-device-cli-scope-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist);
    writeFixtureDist(dist);
    try {
      expect(runPatch(dist).status).toBe(0);
      const source = fs.readFileSync(path.join(dist, "devices-cli.runtime-fixture.js"), "utf8");
      const resolveScopes = runFixture<
        (request: Record<string, unknown>, paired: Record<string, unknown>) => string[]
      >(source, "resolveApprovePairingScopesForRequest");
      expect(
        resolveScopes(validPending(), {
          tokens: [{ role: "operator", scopes: ["operator.pairing"] }],
        }),
      ).toEqual(["operator.pairing"]);
      // The gateway handler and canonical pairing writer remain authoritative
      // for identity and baseline checks. A missing/redacted paired view, or a
      // legacy local view whose tokens are still keyed by role, must not force
      // the CLI to request operator.read before that strict path can run.
      expect(
        resolveScopes(validPending(), undefined as unknown as Record<string, unknown>),
      ).toEqual(["operator.pairing"]);
      expect(
        resolveScopes(validPending(), {
          scopes: ["operator.pairing"],
          tokens: {
            operator: { role: "operator", scopes: ["operator.pairing"] },
          },
        }),
      ).toEqual(["operator.pairing"]);
      expect(
        resolveScopes(validPending(), {
          tokens: [{ role: "operator", scopes: ["operator.read"] }],
        }),
      ).toEqual(["operator.pairing", "operator.read", "operator.write"]);
      expect(
        resolveScopes(validPending({ clientId: "openclaw-control-ui" }), {
          tokens: [{ role: "operator", scopes: ["operator.pairing"] }],
        }),
      ).toEqual(["operator.pairing", "operator.read", "operator.write"]);
      expect(
        resolveScopes(validPending({ isRepair: false }), {
          tokens: [{ role: "operator", scopes: ["operator.pairing"] }],
        }),
      ).toEqual(["operator.pairing"]);
      expect(resolveScopes(validPending({ scopes: ["operator.admin"] }), {})).toEqual([
        "operator.admin",
      ]);
      expect(resolveScopes(validPending({ scopes: ["operator.unknown"] }), {})).toEqual([
        "operator.admin",
      ]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("preflights exact bounded transitions before live list and approval use stored pairing auth", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-device-cli-preflight-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist);
    writeFixtureDist(dist);
    try {
      expect(runPatch(dist).status).toBe(0);
      const source = fs.readFileSync(path.join(dist, "devices-cli.runtime-fixture.js"), "utf8");
      const runtime = runFixture<{
        gatewayCalls: Array<Record<string, unknown>>;
        setPairingLists(local: Record<string, unknown>, live?: Record<string, unknown>): void;
        approvePairingWithFallback(
          opts: Record<string, unknown>,
          requestId: string,
        ): Promise<unknown>;
      }>(source, "({ gatewayCalls, setPairingLists, approvePairingWithFallback })");
      const exactList = { pending: [validPending()], paired: [validPaired()] };
      runtime.setPairingLists(exactList);

      await expect(
        runtime.approvePairingWithFallback({ json: true }, "request-1"),
      ).resolves.toEqual({ requestId: "request-1", approved: true });
      expect(runtime.gatewayCalls).toHaveLength(2);
      (
        [
          ["device.pair.list", runtime.gatewayCalls[0]],
          ["device.pair.approve", runtime.gatewayCalls[1]],
        ] as const
      ).forEach(([method, call]) => {
        expect(call).toMatchObject({
          method,
          scopes: ["operator.pairing"],
          useStoredDeviceAuth: true,
          requiredStoredDeviceAuthScopes: ["operator.pairing"],
        });
        expect(call).not.toHaveProperty("nemoclawDisableStoredDeviceAuth");
      });

      runtime.gatewayCalls.length = 0;
      const preconvergenceList = {
        pending: [validPending({ isRepair: false })],
        paired: [validPaired()],
      };
      runtime.setPairingLists(preconvergenceList);
      await runtime.approvePairingWithFallback({ json: true }, "request-1");
      expect(runtime.gatewayCalls).toHaveLength(2);
      runtime.gatewayCalls.forEach((call) => {
        expect(call).toMatchObject({
          scopes: ["operator.pairing"],
          useStoredDeviceAuth: true,
          requiredStoredDeviceAuthScopes: ["operator.pairing"],
        });
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it.each([true, false])(
    "uses the exact clone paired token for one matching bounded scope upgrade (repair=%s)",
    async (isRepair) => {
      const { runtime, tmp } = openPatchedCliFixture();
      try {
        const token = "clone-paired-token";
        const pending = validPending({ isRepair });
        runtime.setPairingLists(
          { pending: [pending], paired: [clonePairedTokenRecord(token)] },
          { pending: [pending], paired: [validPaired({ approvedScopes: undefined })] },
        );
        runtime.setPairedTokenEnvironment();

        await expect(
          runtime.approvePairingWithFallback({ json: true }, "request-1"),
        ).resolves.toEqual({ requestId: "request-1", approved: true });
        expect(runtime.gatewayCalls.map((call) => call.method)).toEqual([
          "device.pair.list",
          "device.pair.approve",
        ]);
        runtime.gatewayCalls.forEach((call) => {
          expect(call).toMatchObject({
            scopes: ["operator.pairing"],
            credentialSource: "option",
            nemoclawDisableStoredDeviceAuth: true,
            signedIdentityForced: true,
            token,
            url: "ws://127.0.0.1:18789",
          });
          expect(call.password).toBeUndefined();
          expect(call.cliArgUrl).toBeUndefined();
          expect(call.cliArgToken).toBeUndefined();
          expect(call.cliArgPassword).toBeUndefined();
          expect(call).not.toHaveProperty("useStoredDeviceAuth");
          expect(call).not.toHaveProperty("requiredStoredDeviceAuthScopes");
        });
        expect(runtime.pairingStats()).toEqual({
          localPairingReadCount: 0,
          localApprovalCount: 0,
        });
        expect(runtime.pairingDescriptorReads()).toEqual([
          { fd: 41, position: 0 },
          { fd: 42, position: 0 },
        ]);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  );

  it.each([
    ["a missing pending descriptor", { pendingFd: undefined }, {}, {}],
    ["a non-canonical pending descriptor", { pendingFd: "041" }, {}, {}],
    ["a malformed paired descriptor payload", { pairedJson: "{" }, {}, {}],
    ["a different environment gateway URL", { gatewayUrl: "ws://127.0.0.1:28789" }, {}, {}],
    [
      "a whitespace-normalized pinned URL",
      {
        pinnedUrl: " ws://127.0.0.1:18789",
        gatewayUrl: " ws://127.0.0.1:18789",
      },
      {},
      {},
    ],
    [
      "a non-loopback pinned gateway URL",
      {
        pinnedUrl: "ws://gateway.example.test:18789",
        gatewayUrl: "ws://gateway.example.test:18789",
      },
      {},
      {},
    ],
    ["an environment token override", { envToken: "unexpected-token" }, {}, {}],
    ["an environment password override", { password: "unexpected-password" }, {}, {}],
    ["an environment port override", { port: "18789" }, {}, {}],
    ["an explicit CLI token override", {}, {}, { token: "clone-paired-token" }],
    ["an explicit CLI URL override", {}, {}, { url: "ws://127.0.0.1:28789" }],
    ["an explicit CLI password override", {}, {}, { password: "unexpected-password" }],
    [
      "a non-pairing-only paired baseline",
      {},
      {
        scopes: ["operator.pairing", "operator.read"],
        approvedScopes: ["operator.pairing", "operator.read"],
        tokens: {
          operator: {
            token: "clone-paired-token",
            role: "operator",
            scopes: ["operator.pairing", "operator.read"],
          },
        },
      },
      {},
    ],
  ] as const)(
    "rejects a paired-token request with %s before reaching the gateway",
    async (_label, environment, pairedOverrides, approvalOverrides) => {
      const { runtime, tmp } = openPatchedCliFixture();
      try {
        runtime.setPairingLists({
          pending: [validPending({ isRepair: false })],
          paired: [clonePairedTokenRecord("clone-paired-token", pairedOverrides)],
        });
        runtime.setPairedTokenEnvironment(environment);

        await expect(
          runtime.approvePairingWithFallback({ json: true, ...approvalOverrides }, "request-1"),
        ).rejects.toThrow(/forced pairing pinned/u);
        expect(runtime.gatewayCalls).toEqual([]);
        expect(runtime.pairingStats()).toEqual({
          localPairingReadCount: 0,
          localApprovalCount: 0,
        });
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  );

  it("rejects live pairing drift after one direct bounded list and before approval", async () => {
    const { runtime, tmp } = openPatchedCliFixture();
    try {
      const token = "clone-paired-token";
      runtime.setPairingLists(
        {
          pending: [validPending({ isRepair: false })],
          paired: [clonePairedTokenRecord(token)],
        },
        {
          pending: [validPending({ isRepair: false, publicKey: "changed-public-key" })],
          paired: [validPaired({ approvedScopes: undefined })],
        },
      );
      runtime.setPairedTokenEnvironment();

      await expect(runtime.approvePairingWithFallback({ json: true }, "request-1")).rejects.toThrow(
        "bounded same-device approval context changed before gateway approval",
      );
      expect(runtime.gatewayCalls).toHaveLength(1);
      expect(runtime.gatewayCalls[0]).toMatchObject({
        method: "device.pair.list",
        scopes: ["operator.pairing"],
        credentialSource: "option",
        signedIdentityForced: true,
      });
      expect(runtime.pairingStats()).toEqual({
        localPairingReadCount: 0,
        localApprovalCount: 0,
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects a different live request id for the same clone before approval", async () => {
    const { runtime, tmp } = openPatchedCliFixture();
    try {
      const token = "clone-paired-token";
      runtime.setPairingLists(
        {
          pending: [validPending({ isRepair: false })],
          paired: [clonePairedTokenRecord(token)],
        },
        {
          pending: [validPending({ isRepair: false, requestId: "request-2" })],
          paired: [validPaired({ approvedScopes: undefined })],
        },
      );
      runtime.setPairedTokenEnvironment();

      await expect(runtime.approvePairingWithFallback({ json: true }, "request-1")).rejects.toThrow(
        "bounded same-device approval context changed before gateway approval",
      );
      expect(runtime.gatewayCalls).toHaveLength(1);
      expect(runtime.gatewayCalls[0]).toMatchObject({
        method: "device.pair.list",
        scopes: ["operator.pairing"],
        credentialSource: "option",
        signedIdentityForced: true,
      });
      expect(runtime.pairingStats()).toEqual({
        localPairingReadCount: 0,
        localApprovalCount: 0,
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails closed when the direct paired-token list cannot reach the gateway", async () => {
    const { runtime, tmp } = openPatchedCliFixture();
    try {
      const token = "clone-paired-token";
      const pending = validPending({ isRepair: false });
      runtime.setPairingLists({
        pending: [pending],
        paired: [clonePairedTokenRecord(token)],
      });
      runtime.setPairedTokenEnvironment();
      runtime.setGatewayListFailure(new Error("scope-upgrade-pending raw fixture output"));

      await expect(runtime.approvePairingWithFallback({ json: true }, "request-1")).rejects.toThrow(
        "bounded same-device approval context changed before gateway approval",
      );
      expect(runtime.gatewayCalls).toHaveLength(1);
      expect(runtime.gatewayCalls[0]).toMatchObject({
        method: "device.pair.list",
        scopes: ["operator.pairing"],
      });
      expect(runtime.pairingStats()).toEqual({
        localPairingReadCount: 0,
        localApprovalCount: 0,
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it.each([
    ["the administrator retry", "device pairing approval denied"],
    ["unknown-request success", "unknown requestId"],
    ["the local state fallback", "scope-upgrade-pending"],
  ])("fails closed before %s after a paired-token approval error", async (_label, message) => {
    const { runtime, tmp } = openPatchedCliFixture();
    try {
      const token = "clone-paired-token";
      const pending = validPending({ isRepair: false });
      runtime.setPairingLists(
        { pending: [pending], paired: [clonePairedTokenRecord(token)] },
        { pending: [pending], paired: [validPaired({ approvedScopes: undefined })] },
      );
      runtime.setPairedTokenEnvironment();
      runtime.setApprovalFailures([new Error(message)]);

      await expect(runtime.approvePairingWithFallback({ json: true }, "request-1")).rejects.toThrow(
        message,
      );
      expect(runtime.gatewayCalls.map((call) => call.method)).toEqual([
        "device.pair.list",
        "device.pair.approve",
      ]);
      expect(runtime.pairingStats()).toEqual({
        localPairingReadCount: 0,
        localApprovalCount: 0,
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails closed when the live repair no longer matches its exact local preflight", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-device-cli-preflight-drift-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist);
    writeFixtureDist(dist);
    try {
      expect(runPatch(dist).status).toBe(0);
      const source = fs.readFileSync(path.join(dist, "devices-cli.runtime-fixture.js"), "utf8");
      const runtime = runFixture<{
        gatewayCalls: Array<Record<string, unknown>>;
        setPairingLists(local: Record<string, unknown>, live?: Record<string, unknown>): void;
        approvePairingWithFallback(
          opts: Record<string, unknown>,
          requestId: string,
        ): Promise<unknown>;
      }>(source, "({ gatewayCalls, setPairingLists, approvePairingWithFallback })");
      runtime.setPairingLists(
        { pending: [validPending()], paired: [validPaired()] },
        {
          pending: [validPending({ publicKey: "changed-public-key" })],
          paired: [validPaired()],
        },
      );

      await expect(runtime.approvePairingWithFallback({ json: true }, "request-1")).rejects.toThrow(
        "bounded same-device approval context changed before gateway approval",
      );
      expect(runtime.gatewayCalls).toHaveLength(1);
      expect(runtime.gatewayCalls[0]).toMatchObject({
        method: "device.pair.list",
        scopes: ["operator.pairing"],
        useStoredDeviceAuth: true,
        requiredStoredDeviceAuthScopes: ["operator.pairing"],
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("passes authenticated identity for a pre-convergence write request to the canonical approver", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-device-handler-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist);
    writeFixtureDist(dist);
    try {
      expect(runPatch(dist).status).toBe(0);
      const source = fs.readFileSync(path.join(dist, "devices-fixture.js"), "utf8");
      const runtime = runFixture<{
        pendingById: Map<string, Record<string, unknown>>;
        deviceHandlers: Record<string, (input: Record<string, unknown>) => Promise<void>>;
        captured: () => { requestId: string; options: Record<string, unknown> };
      }>(source, `({ pendingById, deviceHandlers, captured: () => capturedApproval })`);
      runtime.pendingById.set("request-1", validPending({ isRepair: false }));
      const responses: unknown[] = [];
      const broadcasts: unknown[] = [];
      await runtime.deviceHandlers["device.pair.approve"]({
        params: { requestId: "request-1" },
        client: validClient(),
        respond: (...args: unknown[]) => responses.push(args),
        context: {
          logGateway: { warn() {}, info() {} },
          broadcast: (...args: unknown[]) => broadcasts.push(args),
        },
      });

      expect(runtime.captured()).toEqual({
        requestId: "request-1",
        options: {
          callerScopes: ["operator.pairing"],
          nemoclawSelfApprovalIdentity: {
            deviceId: "device-1",
            publicKey: "public-key-1",
            role: "operator",
            clientId: "cli",
            clientMode: "cli",
            deviceToken: "token-before",
          },
        },
      });
      expect(responses).toHaveLength(1);
      expect(broadcasts).toHaveLength(1);
      expect(source).not.toMatch(/(?:writeFile|rename|pending\.json|paired\.json)/u);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it.each([
    ["shared auth", validClient({ isDeviceTokenAuth: false })],
    [
      "missing caller identity",
      validClient({
        authz: { callerDeviceId: null, callerScopes: ["operator.pairing"], isAdminCaller: false },
      }),
    ],
    [
      "wrong signed device",
      validClient({
        connect: {
          role: "operator",
          auth: { token: "token-before" },
          device: { id: "device-2", publicKey: "public-key-1" },
          client: { id: "cli", mode: "cli" },
        },
      }),
    ],
    [
      "wrong signed key",
      validClient({
        connect: {
          role: "operator",
          auth: { token: "token-before" },
          device: { id: "device-1", publicKey: "public-key-2" },
          client: { id: "cli", mode: "cli" },
        },
      }),
    ],
    [
      "non-operator connection",
      validClient({
        connect: {
          role: "node",
          auth: { token: "token-before" },
          device: { id: "device-1", publicKey: "public-key-1" },
          client: { id: "cli", mode: "cli" },
        },
      }),
    ],
    [
      "missing device token",
      validClient({
        connect: {
          role: "operator",
          device: { id: "device-1", publicKey: "public-key-1" },
          client: { id: "cli", mode: "cli" },
        },
      }),
    ],
    [
      "admin caller scope",
      validClient({
        authz: {
          callerDeviceId: "device-1",
          callerScopes: ["operator.pairing", "operator.admin"],
          isAdminCaller: false,
        },
      }),
    ],
    [
      "unknown caller scope",
      validClient({
        authz: {
          callerDeviceId: "device-1",
          callerScopes: ["operator.pairing", "operator.unknown"],
          isAdminCaller: false,
        },
      }),
    ],
  ])("does not offer a self-approval identity for %s", async (_label, client) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-device-handler-deny-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist);
    writeFixtureDist(dist);
    try {
      expect(runPatch(dist).status).toBe(0);
      const source = fs.readFileSync(path.join(dist, "devices-fixture.js"), "utf8");
      const runtime = runFixture<{
        pendingById: Map<string, Record<string, unknown>>;
        deviceHandlers: Record<string, (input: Record<string, unknown>) => Promise<void>>;
        captured: () => { options: Record<string, unknown> };
      }>(source, `({ pendingById, deviceHandlers, captured: () => capturedApproval })`);
      runtime.pendingById.set("request-1", validPending());
      await runtime.deviceHandlers["device.pair.approve"]({
        params: { requestId: "request-1" },
        client,
        respond() {},
        context: { logGateway: { warn() {}, info() {} }, broadcast() {} },
      });
      expect(runtime.captured().options.nemoclawSelfApprovalIdentity).toBeNull();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not report or broadcast success when the canonical writer fails", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-device-handler-failure-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist);
    writeFixtureDist(dist);
    try {
      expect(runPatch(dist).status).toBe(0);
      const source = fs.readFileSync(path.join(dist, "devices-fixture.js"), "utf8");
      const runtime = runFixture<{
        pendingById: Map<string, Record<string, unknown>>;
        deviceHandlers: Record<string, (input: Record<string, unknown>) => Promise<void>>;
        fail: (error: Error) => void;
      }>(
        source,
        `({ pendingById, deviceHandlers, fail: (error) => { approvalFailure = error; } })`,
      );
      runtime.pendingById.set("request-1", validPending());
      runtime.fail(new Error("paired publication failed"));
      const responses: unknown[] = [];
      const broadcasts: unknown[] = [];
      await expect(
        runtime.deviceHandlers["device.pair.approve"]({
          params: { requestId: "request-1" },
          client: validClient(),
          respond: (...args: unknown[]) => responses.push(args),
          context: {
            logGateway: { warn() {}, info() {} },
            broadcast: (...args: unknown[]) => broadcasts.push(args),
          },
        }),
      ).rejects.toThrow("paired publication failed");
      expect(responses).toEqual([]);
      expect(broadcasts).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it.each([
    { scenario: "different device ID" },
    { scenario: "different public key" },
    { scenario: "webchat client ID" },
    { scenario: "webchat client mode" },
    { scenario: "node role" },
    { scenario: "empty scopes" },
    { scenario: "scalar scopes" },
    { scenario: "duplicate scopes" },
    { scenario: "admin scope" },
    { scenario: "unknown scope" },
    { scenario: "repair with read scope" },
    { scenario: "missing repair marker" },
  ])(
    "revalidates current identity, operator role, and bounded scopes inside the pairing lock [$scenario]",
    ({ scenario }) => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-device-state-gate-"));
      const dist = path.join(tmp, "dist");
      fs.mkdirSync(dist);
      writeFixtureDist(dist);
      try {
        expect(runPatch(dist).status).toBe(0);
        const source = fs.readFileSync(path.join(dist, "device-pairing-fixture.js"), "utf8");
        const resolveScopes = runFixture<
          (
            pending: Record<string, unknown>,
            callerScopes: unknown[],
            identity: Record<string, unknown>,
          ) => string[] | null
        >(source, "resolveNemoClawSelfApprovalScopes");
        const identity = {
          deviceId: "device-1",
          publicKey: "public-key-1",
          role: "operator",
          clientId: "cli",
          clientMode: "cli",
        };

        expect(resolveScopes(validPending(), ["operator.pairing"], identity)).toEqual([
          "operator.pairing",
          "operator.read",
          "operator.write",
        ]);
        expect(
          resolveScopes(validPending({ isRepair: false }), ["operator.pairing"], identity),
        ).toEqual(["operator.pairing", "operator.read", "operator.write"]);
        const pending = (
          {
            "different device ID": validPending({ deviceId: "device-2" }),
            "different public key": validPending({ publicKey: "public-key-2" }),
            "webchat client ID": validPending({ clientId: "webchat-ui" }),
            "webchat client mode": validPending({ clientMode: "webchat" }),
            "node role": validPending({ role: "node", roles: ["node"] }),
            "empty scopes": validPending({ scopes: [] }),
            "scalar scopes": validPending({ scopes: "operator.write" }),
            "duplicate scopes": validPending({ scopes: ["operator.write", "operator.write"] }),
            "admin scope": validPending({ scopes: ["operator.admin"] }),
            "unknown scope": validPending({ scopes: ["operator.unknown"] }),
            "repair with read scope": validPending({ isRepair: false, scopes: ["operator.read"] }),
            "missing repair marker": validPending({ isRepair: undefined }),
          } as const
        )[scenario]!;
        expect(resolveScopes(pending, ["operator.pairing"], identity)).toBeNull();

        expect(
          resolveScopes(validPending(), ["operator.pairing", "operator.admin"], identity),
        ).toBeNull();
        expect(
          resolveScopes(validPending(), ["operator.pairing", "operator.unknown"], identity),
        ).toBeNull();
        expect(resolveScopes(validPending(), [], identity)).toBeNull();
        expect(
          resolveScopes(validPending(), ["operator.pairing"], { ...identity, role: "node" }),
        ).toBeNull();
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  );

  it.each([
    ["prepared", "pending published first", "after", "before", "before"],
    ["prepared", "paired published first", "before", "after", "before"],
    ["prepared", "stored auth published first", "before", "before", "after"],
    ["committed", "pending published first", "after", "before", "before"],
    ["committed", "paired published first", "before", "after", "before"],
    ["committed", "stored auth published first", "before", "before", "after"],
  ] as const)(
    "recovers a %s journal when %s",
    async (phase, _direction, pendingSide, pairedSide, authSide) => {
      const { runtime, tmp } = openPatchedPairingFixture();
      try {
        const snapshots = transactionSnapshots();
        const currentPending = snapshots[pendingSide].pendingById;
        const currentPaired = snapshots[pairedSide].pairedByDeviceId;
        const { authPath, journalPath } = runtime.getPairingPaths();
        runtime.setPairingState(currentPending, currentPaired);
        runtime.setFile(authPath, snapshots[authSide].auth);
        runtime.setFile(journalPath, transactionJournal(phase, snapshots));

        const listed = await runtime.listDevicePairing();
        const expected = phase === "prepared" ? snapshots.before : snapshots.after;
        expect(runtime.getFile(runtime.getPairingPaths().pendingPath)).toEqual(
          expected.pendingById,
        );
        expect(runtime.getFile(runtime.getPairingPaths().pairedPath)).toEqual(
          expected.pairedByDeviceId,
        );
        expect(runtime.getFile(runtime.getPairingPaths().authPath)).toEqual(expected.auth);
        expect(runtime.getFile(journalPath)).toEqual({
          version: 2,
          kind: "nemoclaw-self-approval",
          phase: "idle",
        });
        expect(listed.pending).toHaveLength(phase === "prepared" ? 1 : 0);
        expect(listed.paired).toHaveLength(1);

        // Recovery is idempotent through another independently locked reader.
        expect(await runtime.getPairedDevice("device-1")).toEqual(
          expected.pairedByDeviceId["device-1"],
        );
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  );

  it("fails closed and preserves a malformed or state-mismatched journal", async () => {
    const { runtime, tmp } = openPatchedPairingFixture();
    try {
      const snapshots = transactionSnapshots();
      const { journalPath, pendingPath } = runtime.getPairingPaths();
      const malformed = {
        version: 2,
        kind: "nemoclaw-self-approval",
        phase: "prepared",
      };
      runtime.setPairingState(snapshots.before.pendingById, snapshots.before.pairedByDeviceId);
      runtime.setFile(journalPath, malformed);
      await expect(runtime.getPendingDevicePairing("request-1")).rejects.toThrow(
        "invalid NemoClaw self-approval journal schema",
      );
      expect(runtime.getFile(journalPath)).toEqual(malformed);

      const mismatchedPending = {
        ...snapshots.before.pendingById,
        "unrelated-request": validPending({
          requestId: "unrelated-request",
          deviceId: "device-2",
          publicKey: "public-key-2",
        }),
      };
      runtime.setPairingState(mismatchedPending, snapshots.before.pairedByDeviceId);
      runtime.setFile(journalPath, transactionJournal("prepared", snapshots));
      await expect(runtime.listDevicePairing()).rejects.toThrow(
        "device pairing state does not match the NemoClaw self-approval journal",
      );
      expect(runtime.getFile(pendingPath)).toEqual(mismatchedPending);
      expect(runtime.getFile(journalPath)).toEqual(transactionJournal("prepared", snapshots));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("waits for a late sibling write before rolling a prepared transaction back", async () => {
    const { runtime, tmp } = openPatchedPairingFixture();
    try {
      const snapshots = transactionSnapshots();
      const paths = runtime.getPairingPaths();
      runtime.setPairingState(snapshots.before.pendingById, snapshots.before.pairedByDeviceId);
      const pairedWriterStarted = runtime.armLateWriterFailure();
      const approval = runtime.approveDevicePairing("request-1", selfApprovalOptions(), "/fixture");
      let settled = false;
      void approval.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );

      await pairedWriterStarted;
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(runtime.getFile(paths.journalPath)).toEqual(
        transactionJournal("prepared", {
          before: snapshots.before,
          after: {
            auth: expect.objectContaining({
              deviceId: "device-1",
              tokens: expect.objectContaining({ operator: expect.any(Object) }),
            }),
            pendingById: {},
            pairedByDeviceId: expect.objectContaining({
              "device-1": expect.objectContaining({ deviceId: "device-1" }),
            }),
          },
        }),
      );

      runtime.releaseLateWriter();
      await expect(approval).rejects.toThrow(
        "failed to publish device pairing and stored-auth state",
      );
      expect(runtime.getFile(paths.pendingPath)).toEqual(snapshots.before.pendingById);
      expect(runtime.getFile(paths.pairedPath)).toEqual(snapshots.before.pairedByDeviceId);
      expect(runtime.getFile(paths.authPath)).toEqual(snapshots.before.auth);
      expect(runtime.getFile(paths.journalPath)).toEqual({
        version: 2,
        kind: "nemoclaw-self-approval",
        phase: "idle",
      });
      const journalWrites = runtime.writes.filter((write) => write.file === paths.journalPath);
      expect(journalWrites.length).toBeGreaterThanOrEqual(2);
      expect(journalWrites.every((write) => write.options?.mode === 384)).toBe(true);
      expect(journalWrites.every((write) => write.options?.dirMode === 448)).toBe(true);
      expect(journalWrites.every((write) => write.options?.trailingNewline === true)).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects a stale loaded snapshot before preparing a journal", async () => {
    const { runtime, tmp } = openPatchedPairingFixture();
    try {
      const snapshots = transactionSnapshots();
      const paths = runtime.getPairingPaths();
      runtime.setPairingState(snapshots.before.pendingById, snapshots.before.pairedByDeviceId);
      const driftedPending = {
        ...snapshots.before.pendingById,
        "request-2": validPending({
          requestId: "request-2",
          deviceId: "device-2",
          publicKey: "public-key-2",
        }),
      };
      runtime.armStateDrift(paths.pendingPath, driftedPending);

      await expect(
        runtime.approveDevicePairing("request-1", selfApprovalOptions(), "/fixture"),
      ).rejects.toThrow("device pairing state changed before NemoClaw self-approval publication");
      expect(runtime.getFile(paths.pendingPath)).toEqual(driftedPending);
      expect(runtime.getFile(paths.pairedPath)).toEqual(snapshots.before.pairedByDeviceId);
      expect(runtime.getFile(paths.journalPath)).toBeNull();

      runtime.setPairingState(snapshots.before.pendingById, snapshots.before.pairedByDeviceId);
      runtime.armStateDrift(paths.authPath, {
        ...snapshots.before.auth,
        tokens: {
          operator: { token: "other-token", role: "operator", scopes: ["operator.pairing"] },
        },
      });
      await expect(
        runtime.approveDevicePairing("request-1", selfApprovalOptions(), "/fixture"),
      ).rejects.toThrow("stored device auth changed before NemoClaw self-approval publication");
      expect(runtime.getFile(paths.journalPath)).toBeNull();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns success when the committed journal landed before its writer reported failure", async () => {
    const { runtime, tmp } = openPatchedPairingFixture();
    try {
      const snapshots = transactionSnapshots();
      const paths = runtime.getPairingPaths();
      runtime.setPairingState(snapshots.before.pendingById, snapshots.before.pairedByDeviceId);
      runtime.armCommittedJournalFailure();

      await expect(
        runtime.approveDevicePairing("request-1", selfApprovalOptions(), "/fixture"),
      ).resolves.toMatchObject({ status: "approved", requestId: "request-1" });
      expect(runtime.getFile(paths.pendingPath)).toEqual({});
      expect(runtime.getFile(paths.pairedPath)).toMatchObject({
        "device-1": { deviceId: "device-1", publicKey: "public-key-1" },
      });
      expect(runtime.getFile(paths.authPath)).toMatchObject({
        deviceId: "device-1",
        tokens: {
          operator: {
            role: "operator",
            scopes: ["operator.write"],
            token: "token",
          },
        },
      });
      expect(runtime.getFile(paths.journalPath)).toEqual({
        version: 2,
        kind: "nemoclaw-self-approval",
        phase: "idle",
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("reports failure until a committed journal clears its credential snapshots", async () => {
    const { runtime, tmp } = openPatchedPairingFixture();
    try {
      const snapshots = transactionSnapshots();
      const paths = runtime.getPairingPaths();
      runtime.setPairingState(snapshots.before.pendingById, snapshots.before.pairedByDeviceId);
      runtime.armIdleJournalFailure();

      await expect(
        runtime.approveDevicePairing("request-1", selfApprovalOptions(), "/fixture"),
      ).rejects.toThrow("idle journal cleanup failed");
      expect(runtime.getFile(paths.journalPath)).toMatchObject({ phase: "committed", version: 2 });

      await expect(runtime.listDevicePairing()).resolves.toMatchObject({ pending: [] });
      expect(runtime.getFile(paths.journalPath)).toEqual({
        version: 2,
        kind: "nemoclaw-self-approval",
        phase: "idle",
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("leaves ordinary approval and bootstrap publication on the canonical writer", async () => {
    const { runtime, source, tmp } = openPatchedPairingFixture();
    try {
      const snapshots = transactionSnapshots();
      const paths = runtime.getPairingPaths();
      runtime.setPairingState(snapshots.before.pendingById, snapshots.before.pairedByDeviceId);
      await expect(
        runtime.approveDevicePairing(
          "request-1",
          { callerScopes: ["operator.pairing", "operator.read", "operator.write"] },
          "/fixture",
        ),
      ).resolves.toMatchObject({ status: "approved" });
      expect(runtime.getFile(paths.journalPath)).toBeNull();

      runtime.writes.length = 0;
      runtime.setPairingState(snapshots.before.pendingById, snapshots.before.pairedByDeviceId);
      await expect(
        runtime.approveBootstrapDevicePairing("request-1", { roles: ["operator"] }, "/fixture"),
      ).resolves.toMatchObject({ status: "approved" });
      expect(runtime.getFile(paths.journalPath)).toBeNull();
      expect(runtime.writes.map((write) => write.file)).toEqual([
        paths.pendingPath,
        paths.pairedPath,
      ]);

      expect(source.match(/return await withLock\(/gu)).toHaveLength(5);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects a pairing-state runtime with only one transaction marker", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-device-partial-marker-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist);
    writeFixtureDist(dist);
    try {
      expect(runPatch(dist).status).toBe(0);
      const file = path.join(dist, "device-pairing-fixture.js");
      fs.writeFileSync(
        file,
        fs
          .readFileSync(file, "utf8")
          .replace(
            "nemoclaw: recover bounded self-approval state transaction",
            "removed transaction marker",
          ),
      );
      const audit = runPatch(dist, true);
      expect(audit.status).toBe(3);
      expect(audit.stdout).toContain("[MISS]");
      expect(audit.stdout).toContain("partial or duplicate patch markers");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it.each([
    (dist: string) => fs.rmSync(path.join(dist, "devices-fixture.js")),
    (dist: string) =>
      fs.copyFileSync(path.join(dist, "devices-fixture.js"), path.join(dist, "devices-copy.js")),
    (dist: string) => {
      const file = path.join(dist, "device-pairing-fixture.js");
      fs.writeFileSync(
        file,
        fs
          .readFileSync(file, "utf8")
          .replace(
            "allowedScopes: options.callerScopes",
            "allowedScopes: [...options.callerScopes]",
          ),
      );
    },
  ])("fails closed on missing, duplicate, and drifted compiled targets [case %#]", (mutate) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-device-patch-drift-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist);
    writeFixtureDist(dist);
    try {
      mutate(dist);
      const audit = runPatch(dist, true);
      expect(audit.status).toBe(3);
      expect(audit.stdout).toContain("[MISS]");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it.each([
    "normalizeDeviceRoles",
    "resolvePairedOperatorScopes",
    "GATEWAY_CLIENT_NAMES",
    "GATEWAY_CLIENT_MODES",
    "OPERATOR_ROLE",
    "PAIRING_SCOPE",
    "normalizeOptionalString",
    "listDevicePairing",
  ])("fails closed when the CLI replacement dependency %s drifts", (dependency) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-device-cli-dependency-drift-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist);
    writeFixtureDist(dist);
    try {
      const file = path.join(dist, "devices-cli.runtime-fixture.js");
      fs.writeFileSync(
        file,
        fs.readFileSync(file, "utf8").replaceAll(dependency, "DRIFTED_DEPENDENCY"),
      );
      const audit = runPatch(dist, true);
      expect(audit.status).toBe(3);
      expect(audit.stdout).toContain("[MISS]");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

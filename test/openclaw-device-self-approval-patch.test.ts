// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  runFixture,
  runPatch,
  validClient,
  validPaired,
  validPending,
  writeFixtureDist,
} from "./helpers/openclaw-device-self-approval-patch-harness";

interface PairingFixtureRuntime {
  writes: Array<{ file: string; value: unknown; options?: Record<string, unknown> }>;
  setPairingState(
    pendingById: Record<string, unknown>,
    pairedByDeviceId: Record<string, unknown>,
    baseDir?: string,
  ): void;
  setFile(file: string, value: unknown): void;
  getFile(file: string): unknown;
  getPairingPaths(baseDir?: string): {
    pendingPath: string;
    pairedPath: string;
    journalPath: string;
  };
  listDevicePairing(baseDir?: string): Promise<{
    pending: Array<Record<string, unknown>>;
    paired: Array<Record<string, unknown>>;
  }>;
  getPairedDevice(deviceId: string, baseDir?: string): Promise<Record<string, unknown> | null>;
  getPendingDevicePairing(
    requestId: string,
    baseDir?: string,
  ): Promise<Record<string, unknown> | null>;
  approveDevicePairing(
    requestId: string,
    options: Record<string, unknown>,
    baseDir?: string,
  ): Promise<Record<string, unknown> | null>;
  approveBootstrapDevicePairing(
    requestId: string,
    bootstrapProfile: Record<string, unknown>,
    baseDir?: string,
  ): Promise<Record<string, unknown> | null>;
  armLateWriterFailure(): Promise<void>;
  releaseLateWriter(): void;
  armCommittedJournalFailure(): void;
  armStateDrift(file: string, value: unknown): void;
}

function openPatchedPairingFixture(): {
  runtime: PairingFixtureRuntime;
  source: string;
  tmp: string;
} {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-device-state-runtime-"));
  const dist = path.join(tmp, "dist");
  fs.mkdirSync(dist);
  writeFixtureDist(dist);
  const apply = runPatch(dist);
  expect(apply.status, `${apply.stdout}${apply.stderr}`).toBe(0);
  const source = fs.readFileSync(path.join(dist, "device-pairing-fixture.js"), "utf8");
  const runtime = runFixture<PairingFixtureRuntime>(
    source,
    `({
      writes,
      setPairingState,
      setFile,
      getFile,
      getPairingPaths,
      listDevicePairing,
      getPairedDevice,
      getPendingDevicePairing,
      approveDevicePairing,
      approveBootstrapDevicePairing,
      armLateWriterFailure,
      releaseLateWriter,
      armCommittedJournalFailure,
      armStateDrift
    })`,
  );
  return { runtime, source, tmp };
}

function transactionSnapshots() {
  const pending = validPending({ ts: 100 });
  const pairedBefore = validPaired({
    approvedAtMs: 100,
    tokens: {
      operator: { token: "token-before", role: "operator", scopes: ["operator.pairing"] },
    },
  });
  const pairedAfter = validPaired({
    approvedAtMs: 200,
    scopes: ["operator.pairing", "operator.read", "operator.write"],
    approvedScopes: ["operator.pairing", "operator.read", "operator.write"],
    tokens: {
      operator: {
        token: "token-after",
        role: "operator",
        scopes: ["operator.pairing", "operator.read", "operator.write"],
      },
    },
  });
  return {
    before: {
      pendingById: { "request-1": pending },
      pairedByDeviceId: { "device-1": pairedBefore },
    },
    after: {
      pendingById: {},
      pairedByDeviceId: { "device-1": pairedAfter },
    },
  };
}

function transactionJournal(
  phase: "prepared" | "committed",
  snapshots: ReturnType<typeof transactionSnapshots>,
) {
  return {
    version: 1,
    kind: "nemoclaw-self-approval",
    phase,
    requestId: "request-1",
    deviceId: "device-1",
    before: snapshots.before,
    after: snapshots.after,
  };
}

function selfApprovalOptions() {
  return {
    callerScopes: ["operator.pairing"],
    nemoclawSelfApprovalIdentity: {
      deviceId: "device-1",
      publicKey: "public-key-1",
      role: "operator",
      clientId: "cli",
      clientMode: "cli",
    },
  };
}

describe("OpenClaw bounded device self-approval patch (#4462)", () => {
  it("applies and audits exactly one CLI, gateway, and canonical-state target", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-device-self-approval-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist);
    writeFixtureDist(dist);
    try {
      const freshAudit = runPatch(dist, true);
      expect(freshAudit.status, `${freshAudit.stdout}${freshAudit.stderr}`).toBe(0);
      expect(freshAudit.stdout).toContain("3 OK · 0 missing");
      expect(freshAudit.stdout).toContain("would-apply");

      const apply = runPatch(dist);
      expect(apply.status, `${apply.stdout}${apply.stderr}`).toBe(0);
      const appliedAudit = runPatch(dist, true);
      expect(appliedAudit.status, `${appliedAudit.stdout}${appliedAudit.stderr}`).toBe(0);
      expect(appliedAudit.stdout.match(/already-applied/gu)).toHaveLength(3);

      const secondApply = runPatch(dist);
      expect(secondApply.status, `${secondApply.stdout}${secondApply.stderr}`).toBe(0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

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
      ).toEqual(["operator.pairing", "operator.read", "operator.write"]);
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

  it("preflights the exact repair before both live list and approval use stored pairing auth", async () => {
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
      for (const [method, call] of [
        ["device.pair.list", runtime.gatewayCalls[0]],
        ["device.pair.approve", runtime.gatewayCalls[1]],
      ] as const) {
        expect(call).toMatchObject({
          method,
          scopes: ["operator.pairing"],
          useStoredDeviceAuth: true,
          requiredStoredDeviceAuthScopes: ["operator.pairing"],
        });
      }

      runtime.gatewayCalls.length = 0;
      const ordinaryList = {
        pending: [validPending({ isRepair: false })],
        paired: [validPaired()],
      };
      runtime.setPairingLists(ordinaryList);
      await runtime.approvePairingWithFallback({ json: true }, "request-1");
      expect(runtime.gatewayCalls[0]).toMatchObject({
        method: "device.pair.list",
        scopes: undefined,
      });
      expect(runtime.gatewayCalls[0]).not.toHaveProperty("useStoredDeviceAuth");
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

  it("passes authenticated identity to the canonical approver and never publishes state itself", async () => {
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
      runtime.pendingById.set("request-1", validPending());
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

  it("revalidates current identity, operator role, and bounded scopes inside the pairing lock", () => {
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
      for (const pending of [
        validPending({ deviceId: "device-2" }),
        validPending({ publicKey: "public-key-2" }),
        validPending({ clientId: "webchat-ui" }),
        validPending({ clientMode: "webchat" }),
        validPending({ role: "node", roles: ["node"] }),
        validPending({ scopes: [] }),
        validPending({ scopes: "operator.write" }),
        validPending({ scopes: ["operator.write", "operator.write"] }),
        validPending({ scopes: ["operator.admin"] }),
        validPending({ scopes: ["operator.unknown"] }),
        validPending({ isRepair: false }),
      ]) {
        expect(resolveScopes(pending, ["operator.pairing"], identity)).toBeNull();
      }
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
  });

  it.each([
    ["prepared", "pending published first", "after", "before"],
    ["prepared", "paired published first", "before", "after"],
    ["committed", "pending published first", "after", "before"],
    ["committed", "paired published first", "before", "after"],
  ] as const)("recovers a %s journal when %s", async (phase, _direction, pendingSide, pairedSide) => {
    const { runtime, tmp } = openPatchedPairingFixture();
    try {
      const snapshots = transactionSnapshots();
      const currentPending = snapshots[pendingSide].pendingById;
      const currentPaired = snapshots[pairedSide].pairedByDeviceId;
      const { journalPath } = runtime.getPairingPaths();
      runtime.setPairingState(currentPending, currentPaired);
      runtime.setFile(journalPath, transactionJournal(phase, snapshots));

      const listed = await runtime.listDevicePairing();
      const expected = phase === "prepared" ? snapshots.before : snapshots.after;
      expect(runtime.getFile(runtime.getPairingPaths().pendingPath)).toEqual(expected.pendingById);
      expect(runtime.getFile(runtime.getPairingPaths().pairedPath)).toEqual(
        expected.pairedByDeviceId,
      );
      expect(runtime.getFile(journalPath)).toEqual({
        version: 1,
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
  });

  it("fails closed and preserves a malformed or state-mismatched journal", async () => {
    const { runtime, tmp } = openPatchedPairingFixture();
    try {
      const snapshots = transactionSnapshots();
      const { journalPath, pendingPath } = runtime.getPairingPaths();
      const malformed = {
        version: 1,
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
            pendingById: {},
            pairedByDeviceId: expect.objectContaining({
              "device-1": expect.objectContaining({ deviceId: "device-1" }),
            }),
          },
        }),
      );

      runtime.releaseLateWriter();
      await expect(approval).rejects.toThrow("failed to publish both device pairing state files");
      expect(runtime.getFile(paths.pendingPath)).toEqual(snapshots.before.pendingById);
      expect(runtime.getFile(paths.pairedPath)).toEqual(snapshots.before.pairedByDeviceId);
      expect(runtime.getFile(paths.journalPath)).toEqual({
        version: 1,
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
      expect(runtime.getFile(paths.journalPath)).toEqual({
        version: 1,
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

  it("fails closed on missing, duplicate, and drifted compiled targets", () => {
    for (const mutate of [
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
    ]) {
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

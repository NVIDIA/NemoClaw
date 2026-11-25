// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import vm from "node:vm";
import { DatabaseSync } from "node:sqlite";
import { createApprovalKernel } from "../../support/openclaw-device-approval";
import { executePairingFixtureQuery } from "../../support/openclaw-device-sqlite";
import { describe, expect, it } from "vitest";
import { patchOpenClawWorkerArchiveModule } from "../../../scripts/lib/patch-openclaw-worker-proxy.mts";
import { OPENCLAW_WORKER_ARCHIVE_PROXY_SOURCE } from "../../fixtures/openclaw-worker-proxy";

const embedded = "sqlite-store.worker.mjs";
function source(name: string) {
  return (
    fs.readFileSync(new URL(`./fixtures/device-worker-${name}.txt`, import.meta.url), "utf8") +
    (name === embedded ? OPENCLAW_WORKER_ARCHIVE_PROXY_SOURCE : "")
  );
}
function patched(name: string) {
  return patchOpenClawWorkerArchiveModule(source(name), name).text;
}
const cli = { clientName: "cli", mode: "cli", sharedStateMode: "read-only" };
const pending = () => ({
  deviceId: "self",
  publicKey: "key",
  clientId: "cli",
  clientMode: "cli",
  role: "operator",
  roles: ["operator"],
  scopes: ["operator.write"],
  isRepair: true,
});
const identity = {
  deviceId: "self",
  publicKey: "key",
  clientId: "cli",
  clientMode: "cli",
  role: "operator",
  deviceToken: "before",
};
const noop = () => {};

describe("OpenClaw archived device authorization", () => {
  it.each([
    embedded,
    "worker-chunk-CJ_iECTX.mjs",
    "worker-chunk-sbeUcZ9t.mjs",
    "worker-chunk-DVgC0w97.mjs",
    "worker-chunk-ESi8iLHn.mjs",
  ])("restores %s exactly and prevents drift from retaining its original digest", (name) => {
    const first = patchOpenClawWorkerArchiveModule(source(name), name);
    expect(patchOpenClawWorkerArchiveModule(first.text, name)).toEqual(first);
    const changed = first.text.replace(/nemoclaw[A-Za-z]+/, "changedSecurityBinding");
    expect(changed).not.toBe(first.text);
    let restored;
    try {
      restored = patchOpenClawWorkerArchiveModule(changed, name);
    } catch (error) {
      expect(String(error)).toContain("Unreviewed worker expression");
      return;
    }
    // An altered injected prefix can leave the original anchor intact. The
    // mandatory whole-archive restoration check must then reject its new hash.
    expect(restored.originalSha256).not.toBe(first.originalSha256);
  });

  it.each([embedded, "worker-chunk-CJ_iECTX.mjs"])(
    "preserves stored-origin and forced identity through %s",
    async (name) => {
      const env: Record<string, string> = {};
      const reads: unknown[] = [];
      let stored: object | null = null;
      let creates = 0;
      const device = { deviceId: "self" };
      const load = (value: unknown) => {
        reads.push(value);
        return stored;
      };
      const create = () => {
        creates++;
        return device;
      };
      const normalize = (v: string) => v?.trim() || undefined;
      const loopback = (v: string) => new URL(v).hostname === "127.0.0.1";
      const names = { CLI: "cli", GATEWAY_CLIENT: "gateway-client" },
        modes = { CLI: "cli", BACKEND: "backend" };
      const runtime = vm.runInNewContext(
        patched(name) + ";({resolveGatewayCallDeviceAuth,authInvocation})",
        {
          process: { env },
          URL,
          Buffer,
          normalizeOptionalString: normalize,
          r: normalize,
          isLoopbackGatewayUrl: loopback,
          se: loopback,
          GATEWAY_CLIENT_NAMES: names,
          O: names,
          GATEWAY_CLIENT_MODES: modes,
          A: modes,
          loadDeviceIdentityIfPresentAsync: () => device,
          B: () => device,
          loadOrCreateDeviceIdentityAsync: create,
          ke: create,
          loadOriginDeviceTokenReadOnly: load,
          loadOriginDeviceToken: load,
          loadDeviceAuthTokenReadOnly: load,
          loadDeviceAuthToken: load,
          Te: load,
          Oe: load,
          we: load,
          Ee: load,
          GatewayLocalBackendSharedAuthUnavailableError: Error,
        },
      );
      const invoke = () =>
        runtime.authInvocation(
          cli,
          "ws://127.0.0.1:18789",
          { mode: "token" },
          undefined,
          { isRemoteMode: false },
          "shared",
          undefined,
          "origin",
        );
      expect(await invoke()).toMatchObject({ omitDeviceIdentity: true, deviceIdentity: null });
      stored = { token: "stored" };
      expect(await invoke()).toMatchObject({ omitDeviceIdentity: false, deviceIdentity: device });
      expect(reads.at(-1)).toMatchObject({
        gatewayScope: "origin",
        deviceId: "self",
        role: "operator",
      });
      reads.length = 0;
      env.NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING = "1";
      const params = {
        opts: { ...cli, deviceIdentity: null },
        url: "ws://127.0.0.1:18789",
        authMode: "token",
        token: "shared",
      };
      expect(await runtime.resolveGatewayCallDeviceAuth(params)).toMatchObject({
        omitDeviceIdentity: false,
        deviceIdentity: device,
      });
      expect(creates).toBe(1);
      expect(reads).toEqual([]);
      await expect(
        runtime.resolveGatewayCallDeviceAuth({
          ...params,
          opts: { ...cli, requireLocalBackendSharedAuth: true },
        }),
      ).rejects.toThrow("local backend shared auth requires");
    },
  );

  describe.each([embedded, "worker-chunk-ESi8iLHn.mjs"])("native authentication in %s", (name) => {
    it.each(["operator.write", "operator.admin"])(
      "keeps native authentication and local approval gates for %s",
      async (scope) => {
        const scopes = [scope];
        let verdict = { ok: false, reason: "scope-mismatch" };
        const received: unknown[] = [];
        const verify = async (params: unknown) => {
          received.push(params);
          return verdict;
        };
        const client = { client: { id: "cli", mode: "cli" } };
        const normalize = (scopes: string[]) => [...new Set(scopes)].sort();
        const runtime = vm.runInNewContext(patched(name) + ";({authDeps,inlineApproval})", {
          verifyDeviceToken: verify,
          qr: verify,
          pr: () => 7,
          d: () => 7,
          Hr: client,
          g: client,
          normalizeSortedUniqueTrimmedStringList: normalize,
          l: normalize,
          resolvePairedAccessScopes: (device: { scopes: string[] }) => device.scopes,
        });
        expect(
          await runtime.authDeps.verifyDeviceToken({ role: "operator", scopes }),
        ).toMatchObject({ ok: true });
        expect(received[0]).toMatchObject({ requiredSharedGatewaySessionGeneration: 7 });
        expect(
          await runtime.authDeps.verifyDeviceToken({ role: "node", scopes: ["operator.write"] }),
        ).toMatchObject({ ok: false });
        expect(
          await runtime.authDeps.verifyDeviceToken({
            role: "operator",
            scopes: ["operator.unknown"],
          }),
        ).toMatchObject({ ok: false });
        verdict = { ok: false, reason: "invalid-token" };
        expect(
          await runtime.authDeps.verifyDeviceToken({
            role: "operator",
            scopes: ["operator.write"],
          }),
        ).toMatchObject({ ok: false });
        const paired = { publicKey: "key", scopes: ["operator.pairing"] };
        expect(
          runtime.inlineApproval(
            paired,
            scopes,
            "scope-upgrade",
            { request: { silent: true, isRepair: true } },
            { localApproval: "silent" },
            "device-token",
            client,
            "operator",
            "key",
            null,
          ),
        ).toBe(false);
        expect(
          runtime.inlineApproval(
            paired,
            [],
            "role-upgrade",
            { request: { silent: false } },
            { localApproval: "silent" },
            "device-token",
            client,
            "node",
            "key",
            null,
          ),
        ).toBe(true);
      },
    );
  });

  it.each([embedded, "worker-chunk-sbeUcZ9t.mjs"])(
    "authorizes ownership before classifying same-device approval in %s",
    async (name) => {
      const row = pending();
      const captured: unknown[] = [];
      const respond = noop;
      const resolve = () => ({
        callerDeviceId: "self",
        callerScopes: ["operator.pairing"],
        isAdminCaller: false,
      });
      const approve = async (_id: string, opts: unknown) => {
        captured.push(opts);
        return null;
      };
      const authz = (row: { roles: string[] }) => row.roles.some((role) => role !== "operator");
      const runtime = vm.runInNewContext(patched(name) + ";deviceHandlers", {
        assertValidParams: () => true,
        N: () => true,
        validateDevicePairApproveParams: {},
        u: {},
        resolveDeviceSessionAuthz: resolve,
        J: resolve,
        getPendingDevicePairing: async () => row,
        A: async () => row,
        requestsNonOperatorDeviceRole: authz,
        se: authz,
        approveDevicePairing: approve,
        L: approve,
        ErrorCodes: {},
        p: {},
        errorShape: noop,
        m: noop,
        emitDevicePairingDeniedSecurityEvent: noop,
      });
      const client = {
        isDeviceTokenAuth: true,
        connect: {
          device: { id: "self", publicKey: "key" },
          client: { id: "cli", mode: "cli" },
          role: "operator",
          auth: { deviceToken: "before" },
        },
      };
      const invoke = () =>
        runtime["device.pair.approve"]({
          params: { requestId: " request " },
          client,
          respond,
          context: { logGateway: { warn: noop } },
        });
      await invoke();
      expect(captured).toEqual([
        { callerScopes: ["operator.pairing"], nemoclawSelfApprovalIdentity: identity },
      ]);
      captured.length = 0;
      row.deviceId = "other";
      await invoke();
      expect(captured).toEqual([]);
      row.deviceId = "self";
      row.roles = ["node"];
      await invoke();
      expect(captured).toEqual([]);
    },
  );

  it.each([embedded, "worker-chunk-DVgC0w97.mjs"])(
    "commits and rolls back token transitions using SQLite in %s",
    (name) => {
      const db = new DatabaseSync(":memory:");
      try {
        db.exec(`CREATE TABLE device_pairing_pending(request_id TEXT PRIMARY KEY,device_id TEXT,public_key TEXT,client_id TEXT,client_mode TEXT);
        CREATE TABLE device_pairing_paired(device_id TEXT PRIMARY KEY,public_key TEXT,tokens_json TEXT);
        CREATE TABLE device_auth_tokens(device_id TEXT,role TEXT,token TEXT,scopes_json TEXT,updated_at_ms INTEGER);
        CREATE TABLE gateway_origin_device_tokens(device_id TEXT,role TEXT,token TEXT,scopes_json TEXT,updated_at_ms INTEGER);`);
        const beforeScopes = JSON.stringify(["operator.pairing"]);
        db.prepare("INSERT INTO device_pairing_pending VALUES(?,?,?,?,?)").run(
          "request",
          "self",
          "key",
          "cli",
          "cli",
        );
        db.prepare("INSERT INTO device_pairing_paired VALUES(?,?,?)").run(
          "self",
          "key",
          JSON.stringify({
            operator: { role: "operator", token: "before", scopes: ["operator.pairing"] },
          }),
        );
        db.prepare("INSERT INTO device_auth_tokens VALUES(?,?,?,?,0)").run(
          "self",
          "operator",
          "before",
          beforeScopes,
        );
        db.prepare("INSERT INTO gateway_origin_device_tokens VALUES(?,?,?,?,0)").run(
          "self",
          "operator",
          "conflicting",
          beforeScopes,
        );
        const execute = (_db: unknown, query: Parameters<typeof executePairingFixtureQuery>[1]) =>
          executePairingFixtureQuery(db, query);
        const kysely = () => ({
          deleteFrom: (table: string) => ({ table }),
          insertInto: (table: string) => ({ values: (rows: unknown[]) => ({ table, rows }) }),
        });
        const persist = vm.runInNewContext(patched(name) + ";persistDevicePairingStoreState", {
          runDevicePairingStoreMutation: (_base: unknown, fn: (arg: unknown) => void) => {
            db.exec("BEGIN");
            try {
              fn({ db });
              db.exec("COMMIT");
            } catch (error) {
              db.exec("ROLLBACK");
              throw error;
            }
          },
          getNodeSqliteKysely: kysely,
          m: kysely,
          executeSqliteQuerySync: execute,
          f: execute,
          toPendingRow: (row: unknown) => row,
          toPairedRow: (device: { deviceId: string; publicKey: string; tokens: object }) => ({
            device_id: device.deviceId,
            public_key: device.publicKey,
            tokens_json: JSON.stringify(device.tokens),
          }),
          clearApnsRegistrationFromDatabase: noop,
        });
        const state = {
          pendingById: {},
          pairedByDeviceId: {
            self: {
              deviceId: "self",
              publicKey: "key",
              tokens: {
                operator: {
                  role: "operator",
                  token: "after",
                  scopes: ["operator.pairing", "operator.read", "operator.write"],
                },
              },
            },
          },
        };
        const invoke = () =>
          persist(state, undefined, "both", {
            nemoclawSelfApproval: { requestId: "request", identity },
          });
        expect(invoke).toThrow("origin-auth precondition failed");
        expect(db.prepare("SELECT token FROM device_auth_tokens").get()).toMatchObject({
          token: "before",
        });
        expect(
          db.prepare("SELECT COUNT(*) AS count FROM device_pairing_pending").get(),
        ).toMatchObject({ count: 1 });
        expect(
          JSON.parse(
            String(db.prepare("SELECT tokens_json FROM device_pairing_paired").get()!.tokens_json),
          ).operator.token,
        ).toBe("before");
        db.prepare("UPDATE gateway_origin_device_tokens SET token = 'before'").run();
        invoke();
        expect(db.prepare("SELECT token FROM device_auth_tokens").get()).toMatchObject({
          token: "after",
        });
        expect(db.prepare("SELECT token FROM gateway_origin_device_tokens").get()).toMatchObject({
          token: "after",
        });
        expect(
          db.prepare("SELECT COUNT(*) AS count FROM device_pairing_pending").get(),
        ).toMatchObject({ count: 0 });
        expect(invoke).toThrow("SQLite state changed before publication");
      } finally {
        db.close();
      }
    },
  );

  describe("archived mutation kernel", () => {
    const emitted = patched(embedded);
    const kernel = emitted.slice(
      emitted.indexOf("function mergeApprovalKind("),
      emitted.indexOf("function persistDevicePairingStoreState("),
    );

    it("publishes a rotated token after admission", () => {
      const f = createApprovalKernel(kernel, "valid");
      expect(f.invoke()).toMatchObject({ status: "approved" });
      expect(f.events).toEqual(["load", "admit", "rotate", "persist"]);
      expect(f.persistenceCalls).toEqual([
        [undefined, "both", { nemoclawSelfApproval: { requestId: "request", identity } }],
      ]);
    });
    it.each(["changed-key", "admin"])("refuses %s authoritative state", (scenario) => {
      const f = createApprovalKernel(kernel, scenario);
      expect(f.invoke()).toMatchObject({ status: "forbidden" });
      expect(f.events).toEqual(["load", "admit"]);
      expect(f.persistenceCalls).toEqual([]);
    });
    it("leaves an expired request unchanged", () => {
      const f = createApprovalKernel(kernel, "expired");
      expect(f.invoke()).toBeNull();
      expect(f.events).toEqual(["load"]);
      expect(f.persistenceCalls).toEqual([]);
    });
    it("stops before token rotation when admission fails", () => {
      const f = createApprovalKernel(kernel, "admission-denied");
      expect(f.invoke).toThrow("admission denied");
      expect(f.events).toEqual(["load", "admit"]);
      expect(f.persistenceCalls).toEqual([]);
    });
  });
});

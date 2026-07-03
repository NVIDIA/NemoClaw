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
  validPending,
  writeFixtureDist,
} from "./helpers/openclaw-device-self-approval-patch-harness";

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
      expect(resolveScopes(validPending(), { tokenScopes: ["operator.pairing"] })).toEqual([
        "operator.pairing",
      ]);
      expect(
        resolveScopes(validPending({ clientId: "openclaw-control-ui" }), {
          tokenScopes: ["operator.pairing"],
        }),
      ).toEqual(["operator.pairing", "operator.write"]);
      expect(
        resolveScopes(validPending({ isRepair: false }), {
          tokenScopes: ["operator.pairing"],
        }),
      ).toEqual(["operator.pairing", "operator.write"]);
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
});

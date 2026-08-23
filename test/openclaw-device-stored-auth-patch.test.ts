// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  runFixture,
  runPatch,
  validPaired,
  validPending,
  writeFixtureDist,
} from "./helpers/openclaw-device-self-approval-patch-harness";

describe("OpenClaw bounded stored-device-auth selection (#4462)", () => {
  it("uses pairing-only stored auth only for a marked settlement list (#9844)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-device-cli-settlement-list-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist);
    writeFixtureDist(dist);
    try {
      expect(runPatch(dist).status).toBe(0);
      const source = fs.readFileSync(path.join(dist, "devices-cli.runtime-fixture.js"), "utf8");
      const runtime = runFixture<{
        list: (opts: Record<string, unknown>) => Promise<unknown>;
        calls: Array<Record<string, unknown>>;
        setSettlement: (enabled: boolean) => void;
      }>(
        source,
        `({
          list: listPairingWithFallback,
          calls: gatewayCalls,
          setSettlement: (enabled) => {
            if (enabled) process.env.NEMOCLAW_OPENCLAW_PAIRING_SETTLEMENT = "1";
            else delete process.env.NEMOCLAW_OPENCLAW_PAIRING_SETTLEMENT;
          },
        })`,
      );

      runtime.setSettlement(false);
      await runtime.list({ json: true });
      runtime.setSettlement(true);
      await runtime.list({ json: true });

      expect(runtime.calls[0]).toMatchObject({ method: "device.pair.list" });
      expect(runtime.calls[0]).not.toHaveProperty("useStoredDeviceAuth");
      expect(runtime.calls[1]).toMatchObject({
        method: "device.pair.list",
        scopes: ["operator.pairing"],
        useStoredDeviceAuth: true,
        requiredStoredDeviceAuthScopes: ["operator.pairing"],
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it.each([
    ["repair", validPending()],
    ["nonrepair", validPending({ isRepair: false })],
  ])(
    "forwards stored device auth for an exact same-device %s transition",
    async (_label, pending) => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-device-cli-stored-auth-"));
      const dist = path.join(tmp, "dist");
      fs.mkdirSync(dist);
      writeFixtureDist(dist);
      try {
        expect(runPatch(dist).status).toBe(0);
        const source = fs.readFileSync(path.join(dist, "devices-cli.runtime-fixture.js"), "utf8");
        const runtime = runFixture<{
          approve: (opts: Record<string, unknown>, requestId: string) => Promise<unknown>;
          calls: Array<Record<string, unknown>>;
          setList: (value: Record<string, unknown>) => void;
        }>(
          source,
          `({
          approve: approvePairingWithFallback,
          calls: gatewayCalls,
          setList: setPairingLists,
        })`,
        );
        runtime.setList({ pending: [pending], paired: [validPaired()] });

        await runtime.approve({ json: true }, "request-1");

        expect(runtime.calls).toHaveLength(2);
        for (const [method, call] of [
          ["device.pair.list", runtime.calls[0]],
          ["device.pair.approve", runtime.calls[1]],
        ] as const) {
          expect(call).toMatchObject({
            method,
            scopes: ["operator.pairing"],
            useStoredDeviceAuth: true,
            requiredStoredDeviceAuthScopes: ["operator.pairing"],
          });
        }
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  );

  it.each([
    ["missing paired view", validPending(), undefined, true],
    ["mismatched device", validPending(), validPaired({ deviceId: "device-2" }), true],
    ["mismatched key", validPending(), validPaired({ publicKey: "public-key-2" }), true],
    ["missing device", validPending({ deviceId: "" }), validPaired(), true],
    ["missing key", validPending({ publicKey: "" }), validPaired(), true],
    [
      "nonrepair pairing-only request",
      validPending({ isRepair: false, scopes: ["operator.pairing"] }),
      validPaired(),
      false,
    ],
    ["wrong client", validPending({ clientId: "openclaw-control-ui" }), validPaired(), false],
    ["wrong mode", validPending({ clientMode: "webchat" }), validPaired(), false],
    ["multiple roles", validPending({ roles: ["operator", "node"] }), validPaired(), false],
    ["non-operator role", validPending({ role: "node", roles: ["node"] }), validPaired(), false],
    ["admin scope", validPending({ scopes: ["operator.admin"] }), validPaired(), false],
    ["unknown scope", validPending({ scopes: ["operator.unknown"] }), validPaired(), false],
    [
      "duplicate scope",
      validPending({ scopes: ["operator.write", "operator.write"] }),
      validPaired(),
      true,
    ],
    [
      "non-pairing baseline",
      validPending(),
      validPaired({
        scopes: ["operator.read"],
        approvedScopes: ["operator.read"],
        tokens: [{ role: "operator", scopes: ["operator.read"] }],
      }),
      false,
    ],
  ])(
    "does not select stored device auth for %s",
    async (_label, pending, paired, expectPairingTransport) => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-device-cli-no-stored-auth-"));
      const dist = path.join(tmp, "dist");
      fs.mkdirSync(dist);
      writeFixtureDist(dist);
      try {
        expect(runPatch(dist).status).toBe(0);
        const source = fs.readFileSync(path.join(dist, "devices-cli.runtime-fixture.js"), "utf8");
        const classify = runFixture<
          (
            request: Record<string, unknown>,
            pairedDevice: Record<string, unknown> | undefined,
          ) => { usePairingTransport: boolean; useStoredDeviceAuth: boolean }
        >(source, "resolveNemoClawSelfRepairPairingContext");
        const result = classify(
          pending as Record<string, unknown>,
          paired as Record<string, unknown> | undefined,
        );
        expect(result.useStoredDeviceAuth).toBe(false);
        expect(result.usePairingTransport).toBe(expectPairingTransport);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  );

  it("fails closed without an admin retry when exact stored-device approval is denied", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-device-cli-admin-retry-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist);
    writeFixtureDist(dist);
    try {
      expect(runPatch(dist).status).toBe(0);
      const source = fs.readFileSync(path.join(dist, "devices-cli.runtime-fixture.js"), "utf8");
      const runtime = runFixture<{
        approve: (opts: Record<string, unknown>, requestId: string) => Promise<unknown>;
        calls: Array<Record<string, unknown>>;
        failApprovals: (errors: Error[]) => void;
        setList: (value: Record<string, unknown>) => void;
      }>(
        source,
        `({
          approve: approvePairingWithFallback,
          calls: gatewayCalls,
          failApprovals: (errors) => { approvalFailures = errors; },
          setList: setPairingLists,
        })`,
      );
      runtime.setList({ pending: [validPending()], paired: [validPaired()] });
      runtime.failApprovals([new Error("device pairing approval denied")]);

      await expect(runtime.approve({ json: true }, "request-1")).rejects.toThrow(
        "device pairing approval denied",
      );

      expect(runtime.calls).toHaveLength(2);
      expect(runtime.calls[0]).toMatchObject({
        method: "device.pair.list",
        useStoredDeviceAuth: true,
        requiredStoredDeviceAuthScopes: ["operator.pairing"],
      });
      expect(runtime.calls[1]).toMatchObject({
        method: "device.pair.approve",
        useStoredDeviceAuth: true,
        requiredStoredDeviceAuthScopes: ["operator.pairing"],
      });
      expect(runtime.calls).not.toContainEqual(
        expect.objectContaining({ scopes: ["operator.admin"] }),
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("keeps cold bootstrap transport on the exact bounded non-repair target", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-device-cli-admin-retry-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist);
    writeFixtureDist(dist);
    try {
      expect(runPatch(dist).status).toBe(0);
      const source = fs.readFileSync(path.join(dist, "devices-cli.runtime-fixture.js"), "utf8");
      const runtime = runFixture<{
        approve: (opts: Record<string, unknown>, requestId: string) => Promise<unknown>;
        calls: Array<Record<string, unknown>>;
        failApprovals: (errors: Error[]) => void;
        setList: (value: Record<string, unknown>) => void;
      }>(
        source,
        `({
          approve: approvePairingWithFallback,
          calls: gatewayCalls,
          failApprovals: (errors) => { approvalFailures = errors; },
          setList: setPairingLists,
        })`,
      );
      runtime.setList({
        pending: [validPending({ isRepair: false })],
        paired: [],
      });
      runtime.failApprovals([new Error("device pairing approval denied")]);

      await runtime.approve({ json: true }, "request-1");

      expect(runtime.calls).toHaveLength(3);
      expect(runtime.calls[1]).toMatchObject({
        method: "device.pair.approve",
        params: { requestId: "request-1" },
        scopes: ["operator.pairing", "operator.read", "operator.write"],
      });
      expect(runtime.calls[1]).not.toHaveProperty("useStoredDeviceAuth");
      expect(runtime.calls[2]).toMatchObject({
        method: "device.pair.approve",
        params: { requestId: "request-1" },
        scopes: ["operator.admin"],
      });
      expect(runtime.calls[2]).not.toHaveProperty("useStoredDeviceAuth");
      expect(runtime.calls[2]).not.toHaveProperty("requiredStoredDeviceAuthScopes");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import {
  createApprovalKernel,
  createApprovalCommand,
  identity,
  pending,
} from "../../support/openclaw-device-approval";
const noop = () => {};
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  runPatch,
  writeCurrentGatewayCallFixtureDist,
} from "../../helpers/openclaw-device-self-approval-patch-harness";

const fixture = (name: string) =>
  fs.readFileSync(new URL(`./fixtures/${name}-10.5.js.txt`, import.meta.url), "utf8");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-device-105-"));
const dist = path.join(root, "dist");
const read = (name: string) => fs.readFileSync(path.join(dist, name), "utf8");
beforeAll(() => {
  fs.mkdirSync(dist);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "2026.10.5" }));
  writeCurrentGatewayCallFixtureDist(dist);
  fs.writeFileSync(
    path.join(dist, "call-current-fixture.js"),
    fixture("device-identity-import") + fixture("device-call"),
  );
  fs.mkdirSync(path.join(dist, "native-hook-relay"));
  fs.writeFileSync(path.join(dist, "native-hook-relay", "call-relay.mjs"), fixture("device-call"));
  for (const [name, file] of Object.entries({
    "device-cli": "devices-cli.runtime-fixture.js",
    "device-kernel": "device-pairing-fixture.js",
    "device-handler": "devices-fixture.js",
    "device-persistence": "persistence.mjs",
    "device-agent": "agent.mjs",
  }))
    fs.writeFileSync(path.join(dist, file), fixture(name));
  const auth = "message-handler-fixture.js";
  fs.writeFileSync(
    path.join(dist, auth),
    read(auth).replace(
      "pairing.request.silent === true;",
      'pairing.request.silent === true || role === "node" && reason === "role-upgrade" && plan.localApproval === "silent";',
    ),
  );
  const audit = runPatch(dist, true);
  expect(audit.status, audit.stdout + audit.stderr).toBe(0);
  const applied = runPatch(dist);
  expect(applied.status, applied.stdout + applied.stderr).toBe(0);
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("OpenClaw 2026.10.5 readable approval migration", () => {
  it("loads shared payloads from the flat image installation", () => {
    const flat = path.join(root, "flat");
    fs.mkdirSync(flat);
    fs.copyFileSync(
      new URL("../../../scripts/patch-openclaw-device-self-approval.mts", import.meta.url),
      path.join(flat, "patch.mts"),
    );
    fs.copyFileSync(
      new URL("../../../scripts/lib/openclaw-device-patch-payloads.mts", import.meta.url),
      path.join(flat, "openclaw-device-patch-payloads.mts"),
    );
    const result = spawnSync(process.execPath, [path.join(flat, "patch.mts"), "--audit", dist], {
      encoding: "utf8",
      timeout: 10000,
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("Summary: 11 OK · 0 missing");
  });
  it("audits and reapplies all eleven targets without changing the result", () => {
    const files = fs
      .readdirSync(dist)
      .filter((name) => name !== "native-hook-relay")
      .concat("native-hook-relay/call-relay.mjs");
    const before = files.map((file) => read(file));
    expect(runPatch(dist, true).stdout).toContain("Summary: 11 OK · 0 missing");
    expect(runPatch(dist).status).toBe(0);
    expect(files.map((file) => read(file))).toEqual(before);
    expect(read("native-hook-relay/call-relay.mjs")).toContain(
      "nemoclaw: retain stored CLI device identity",
    );
  });

  it.each([["operator.write"], ["operator.admin"]])(
    "retains native node approval while deferring CLI scope %s",
    (...scopes) => {
      const resolve = vm.runInNewContext(
        read("message-handler-fixture.js") + "\nresolvePairingOutcome",
      );
      const input = {
        authMethod: "device-token",
        connectParams: { client: { id: "cli", mode: "cli" } },
        devicePublicKey: "key",
        existingPairedDevice: { publicKey: "key", scopes: ["operator.pairing"] },
        pairing: { request: { isRepair: true, silent: true } },
        plan: { localApproval: "silent" },
        trustedProxyApprovalScopes: null,
      };
      expect(resolve({ ...input, role: "node", reason: "role-upgrade", scopes: [] })).toBe(
        "approved",
      );
      expect(resolve({ ...input, role: "operator", reason: "scope-upgrade", scopes })).toBe(
        "pending",
      );
    },
  );

  it("publishes the rotated token only after admission", () => {
    const f = createApprovalKernel(read("device-pairing-fixture.js"), "valid");
    expect(f.invoke()).toMatchObject({
      status: "approved",
      device: { tokens: { operator: { token: "after" } } },
    });
    expect(f.events).toEqual(["load", "admit", "rotate", "persist"]);
    expect(f.persistenceCalls).toEqual([
      [undefined, "both", { nemoclawSelfApproval: { requestId: "request", identity } }],
    ]);
  });
  it.each(["changed-key", "admin"])("refuses %s authoritative state", (scenario) => {
    const f = createApprovalKernel(read("device-pairing-fixture.js"), scenario);
    expect(f.invoke()).toMatchObject({ status: "forbidden", reason: "caller-missing-scope" });
    expect(f.events).toEqual(["load", "admit"]);
    expect(f.persistenceCalls).toEqual([]);
  });
  it("leaves an expired request unchanged", () => {
    const f = createApprovalKernel(read("device-pairing-fixture.js"), "expired");
    expect(f.invoke()).toBeNull();
    expect(f.events).toEqual(["load"]);
    expect(f.persistenceCalls).toEqual([]);
  });
  it("stops before token rotation when admission fails", () => {
    const f = createApprovalKernel(read("device-pairing-fixture.js"), "admission-denied");
    expect(f.invoke).toThrow("admission denied");
    expect(f.events).toEqual(["load", "admit"]);
    expect(f.persistenceCalls).toEqual([]);
  });
  it("propagates transaction failure without returning an approval", () => {
    const f = createApprovalKernel(read("device-pairing-fixture.js"), "persistence-failed");
    expect(f.invoke).toThrow("transaction failed");
    expect(f.events).toEqual(["load", "admit", "rotate", "persist"]);
    expect(f.persistenceCalls).toEqual([
      [undefined, "both", { nemoclawSelfApproval: { requestId: "request", identity } }],
    ]);
  });

  it.each(["self", "other-device", "node-role", "shared-auth"])(
    "preserves native handler authorization for %s",
    async (scenario) => {
      const row = {
        ...pending(),
        deviceId: scenario === "other-device" ? "other" : "self",
        roles: scenario === "node-role" ? ["node"] : ["operator"],
      };
      const captured: unknown[] = [];
      const responses: unknown[][] = [];
      const handler = vm.runInNewContext(
        read("devices-fixture.js") + '\ndeviceHandlers["device.pair.approve"]',
        {
          assertValidParams: () => true,
          validateDevicePairApproveParams: {},
          getPendingDevicePairing: async () => row,
          approveDevicePairing: async (_request: string, options: unknown) => {
            captured.push(options);
            return { status: "forbidden", reason: "proof-stops-at-kernel" };
          },
          emitDevicePairingDeniedSecurityEvent: noop,
          errorShape: (_code: unknown, message: string) => ({ message }),
          ErrorCodes: { INVALID_REQUEST: "invalid" },
          formatDevicePairingForbiddenMessage: () => "forbidden",
        },
      );
      await handler({
        params: { requestId: " request " },
        client: {
          isDeviceTokenAuth: scenario !== "shared-auth",
          connect: {
            scopes: ["operator.pairing"],
            role: "operator",
            device: { id: "self", publicKey: "key" },
            client: { id: "cli", mode: "cli" },
            auth: { deviceToken: "before" },
          },
        },
        respond: (...args: unknown[]) => responses.push(args),
        context: { logGateway: { warn: noop } },
      });
      expect(responses[0][0]).toBe(false);
      expect(captured).toEqual(
        scenario === "other-device" || scenario === "node-role"
          ? []
          : [
              {
                callerScopes: ["operator.pairing"],
                nemoclawSelfApprovalIdentity: scenario === "self" ? identity : null,
              },
            ],
      );
    },
  );

  it.each(["json", "text", "other-device"])(
    "confirms the admin token before %s output",
    async (scenario) => {
      const f = createApprovalCommand(read("devices-cli.runtime-fixture.js"), scenario);
      await f.invoke();
      expect(f.events).toEqual(
        scenario === "other-device"
          ? ["identity", "output", "exit:0"]
          : ["identity", "confirm", "output", "exit:0"],
      );
      expect(f.confirmations).toEqual(
        scenario === "other-device"
          ? []
          : [
              {
                method: "device.pair.list",
                token: "private-rotated",
                password: undefined,
                scopes: ["operator.admin"],
              },
            ],
      );
      expect(f.outputs).toHaveLength(1);
      expect(JSON.stringify(f.outputs)).not.toContain("private-rotated");
    },
  );
  it.each([
    {
      scenario: "identity-failed",
      message: "could not read",
      events: ["identity"],
      confirmations: [],
    },
    {
      scenario: "confirmation-failed",
      message: "denied",
      events: ["identity", "confirm"],
      confirmations: [
        {
          method: "device.pair.list",
          token: "private-rotated",
          password: undefined,
          scopes: ["operator.admin"],
        },
      ],
    },
  ])(
    "withholds success output when $scenario",
    async ({ scenario, message, events, confirmations }) => {
      const f = createApprovalCommand(read("devices-cli.runtime-fixture.js"), scenario);
      await expect(f.invoke()).rejects.toThrow(message);
      expect(f.events).toEqual(events);
      expect(f.confirmations).toEqual(confirmations);
      expect(f.outputs).toEqual([]);
    },
  );

  describe.each([false, true])("agent command with remote=%s", (remoteGateway) => {
    it.each([{ modelOverride: "model" }, { body: "/new" }, { body: "/reset" }])(
      "keeps explicit admin requirements for %j",
      async (opts) => {
        const run = vm.runInNewContext(read("agent.mjs") + "\nagentViaGatewayCommand", {
          ADMIN_SCOPE: "operator.admin",
          isSessionResetCommand: (body: string) => ["/new", "/reset"].includes(body),
          GATEWAY_CLIENT_NAMES: { CLI: "cli", GATEWAY_CLIENT: "gateway-client" },
          GATEWAY_CLIENT_MODES: { CLI: "cli", BACKEND: "backend" },
        });
        expect(await run({ remoteGateway, body: "ordinary" })).toEqual({
          clientName: "cli",
          mode: "cli",
        });

        expect(await run({ remoteGateway, ...opts })).toEqual({
          clientName: "gateway-client",
          mode: "backend",
          scopes: ["operator.admin"],
        });
      },
    );
  });
});

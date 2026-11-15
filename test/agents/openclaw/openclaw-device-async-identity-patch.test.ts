// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAsyncIdentityRuntime } from "../../support/openclaw-async-device-identity";
import { afterEach, describe, expect, it } from "vitest";
import {
  runPatch,
  writeFixtureDist,
} from "../../helpers/openclaw-device-self-approval-patch-harness";

const source = fs.readFileSync(
  new URL("./fixtures/device-call-10.5.js.txt", import.meta.url),
  "utf8",
);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(text = source, version = "2026.10.5") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-async-identity-"));
  roots.push(root);
  const dist = path.join(root, "dist");
  fs.mkdirSync(dist);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version }));
  writeFixtureDist(dist);
  fs.rmSync(path.join(dist, "device-identity-fixture.js"));
  const file = path.join(dist, "call-fixture.js");
  fs.writeFileSync(file, text);
  return { root, dist, file };
}

function openRuntime() {
  const files = fixture();
  const applied = runPatch(files.dist);
  expect(applied.status, applied.stderr).toBe(0);
  const patched = fs.readFileSync(files.file, "utf8");
  expect(runPatch(files.dist).status).toBe(0);
  expect(fs.readFileSync(files.file, "utf8")).toBe(patched);
  return { ...files, ...createAsyncIdentityRuntime(patched) };
}

const cli = { clientName: "cli", mode: "cli", sharedStateMode: "read-only" };
const params = { opts: cli, url: "ws://127.0.0.1:18789", authMode: "token", token: "shared" };

describe("OpenClaw 2026.10.5 asynchronous device identity", () => {
  it("keeps bootstrap omission and restores the stored CLI identity for its gateway origin", async () => {
    const f = openRuntime();
    expect(await f.runtime.resolve(params)).toMatchObject({
      omitDeviceIdentity: true,
      deviceIdentity: null,
    });
    f.state.token = { token: "stored", scopes: ["operator.pairing"] };
    expect(
      await f.runtime.invoke(
        cli,
        params.url,
        { mode: "token" },
        undefined,
        { isRemoteMode: false },
        "shared",
        undefined,
        "origin-1",
      ),
    ).toMatchObject({ omitDeviceIdentity: false, deviceIdentity: f.identity });
    expect(f.tokenReads.at(-1)).toMatchObject({
      gatewayScope: "origin-1",
      deviceId: f.identity.deviceId,
      role: "operator",
    });
    expect(f.state.creates).toBe(0);
  });

  it("preserves backend omission and remote identity without a local shared-auth lookup", async () => {
    const f = openRuntime();
    expect(
      await f.runtime.resolve({
        ...params,
        opts: { clientName: "gateway-client", mode: "backend" },
      }),
    ).toMatchObject({ omitDeviceIdentity: true, deviceIdentity: null });
    expect(f.state.reads + f.state.creates).toBe(0);
    expect(await f.runtime.resolve({ ...params, url: "wss://gateway.example" })).toMatchObject({
      omitDeviceIdentity: false,
      deviceIdentity: f.identity,
    });
    expect(f.tokenReads).toHaveLength(0);
  });

  it("propagates native identity failures and preserves the cause", async () => {
    const f = openRuntime();
    f.state.error = new Error("state unavailable");
    await expect(f.runtime.resolve(params)).rejects.toMatchObject({ cause: f.state.error });
  });

  it("binds restored identity to its descriptor despite an explicit identity override", async () => {
    const f = openRuntime();
    const pair = crypto.generateKeyPairSync("ed25519");
    const deviceId = crypto
      .createHash("sha256")
      .update(pair.publicKey.export({ type: "spki", format: "der" }).subarray(-32))
      .digest("hex");
    const file = path.join(f.root, "identity.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        deviceId,
        publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }),
        privateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }),
      }),
    );
    const fd = fs.openSync(file, "r");
    try {
      Object.assign(f.env, {
        NEMOCLAW_OPENCLAW_RESTORED_CLONE_PAIRING: "1",
        NEMOCLAW_OPENCLAW_IDENTITY_FD: String(fd),
        NEMOCLAW_OPENCLAW_EXPECTED_DEVICE_ID: deviceId,
      });
      expect(
        await f.runtime.resolve({ ...params, opts: { ...cli, deviceIdentity: null } }),
      ).toMatchObject({ omitDeviceIdentity: false, deviceIdentity: { deviceId } });
      expect(f.state.reads + f.state.creates).toBe(0);
      expect(f.tokenReads).toHaveLength(0);
      f.env.NEMOCLAW_OPENCLAW_EXPECTED_DEVICE_ID = "different";
      await expect(f.runtime.resolve(params)).rejects.toThrow("does not match the clone");
      delete f.env.NEMOCLAW_OPENCLAW_IDENTITY_FD;
      await expect(f.runtime.resolve(params)).rejects.toThrow("descriptor is unavailable");
    } finally {
      fs.closeSync(fd);
    }
  });

  it("forces bootstrap identity and rejects incompatible backend requirements", async () => {
    const f = openRuntime();
    f.env.NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING = "1";
    expect(await f.runtime.resolve(params)).toMatchObject({
      omitDeviceIdentity: false,
      deviceIdentity: f.identity,
    });
    expect(f.state.creates).toBe(1);
    expect(f.tokenReads).toHaveLength(0);
    await expect(
      f.runtime.resolve({ ...params, opts: { ...cli, requireLocalBackendSharedAuth: true } }),
    ).rejects.toThrow("local backend shared auth requires");
  });

  it.each(["version", "shape"])("rejects %s drift before writing the identity module", (kind) => {
    const f = fixture(
      kind === "shape" ? source.replace("catch (cause)", "catch (error)") : source,
      kind === "version" ? "2026.10.6" : "2026.10.5",
    );
    const before = fs.readFileSync(f.file, "utf8");
    expect(runPatch(f.dist).status).toBe(1);
    expect(fs.readFileSync(f.file, "utf8")).toBe(before);
  });
});

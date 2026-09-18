// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { configureNativeFromStdin } from "./native-setup-configuration.mts";
import { nativeCredentialBinding } from "./native-security.mts";
import { nativeServiceBinding } from "./native-options.mts";

const configuration = {
  schemaVersion: 1,
  classification: "nemoclaw-native-windows-agent-configuration",
  agent: "hermes",
  inference: "compatible",
  endpoint: "https://example.invalid/v1",
  model: "test-model",
  credentialStored: true,
  profile: "personal",
  options: { search: { provider: "tavily", credentialStored: true } },
};
const credentials = { inference: "new-inference", services: { tavily: "new-tavily" } };

for (const failure of ["none", "credential", "services", "active-pointer"]) {
  test(`setup transaction ${failure} binds credentials and configuration to one state lease`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-transaction-"));
    const previousEnvironment = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = root;
    const configPath = path.join(
      root,
      "NVIDIA",
      "NemoClaw",
      "agents",
      "hermes",
      "native-windows.json",
    );
    const activePath = path.join(root, "NVIDIA", "NemoClaw", "active-agent.txt");
    const previous = JSON.stringify({ ...configuration, model: "previous-model" });
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, previous);
    fs.writeFileSync(activePath, "openclaw\n");
    const inferenceBinding = nativeCredentialBinding(configuration);
    const serviceBinding = nativeServiceBinding("hermes", "tavily");
    const initial = new Map([
      [inferenceBinding, "old-inference"],
      [serviceBinding, "old-tavily"],
    ]);
    const vault = new Map(initial);
    let held = false;
    let released = false;
    let writes = 0;
    let admit!: () => void;
    const admitted = new Promise<void>((resolve) => {
      admit = resolve;
    });
    let acquiring!: () => void;
    const acquisitionStarted = new Promise<void>((resolve) => {
      acquiring = resolve;
    });
    const originalRename = fs.renameSync;
    if (failure === "active-pointer")
      t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
        if (to === activePath) throw new Error("simulated active-agent rename failure");
        originalRename(from, to);
      });
    const input = Buffer.from(JSON.stringify({ configuration, credentials }));
    try {
      const pending = configureNativeFromStdin(
        "unused",
        ["--transaction"],
        Readable.from([input]),
        process.stdout,
        {
          acquireState: async () => {
            acquiring();
            await admitted;
            held = true;
            return {
              stateRoot: root,
              created: false,
              removed: false,
              assertHeld() {
                assert(held);
              },
              async release() {
                held = false;
                released = true;
              },
            };
          },
          credentialStore: {
            read: async (_launcher, change) => {
              assert(held);
              return vault.get(change.binding) ?? "";
            },
            write: async (_launcher, change) => {
              assert(held);
              writes++;
              if (change.value) vault.set(change.binding, change.value);
              else vault.delete(change.binding);
              if (failure === "credential" && writes === 1) throw new Error("secret failure");
            },
          },
          readCredential: async () => {
            assert(held);
            return vault.get(inferenceBinding)!;
          },
          readServices: async () => {
            assert(held);
            assert.equal(vault.get(serviceBinding), "new-tavily");
            if (failure === "services") throw new Error("secret service failure");
            return { options: {}, environment: {} };
          },
        },
      );
      // Removal can keep this owner waiting; neither the vault nor configuration may move.
      await acquisitionStarted;
      assert.equal(writes, 0);
      assert.equal(fs.readFileSync(configPath, "utf8"), previous);
      admit();
      if (failure === "none") {
        assert.equal(await pending, configPath);
        assert.equal(vault.get(inferenceBinding), "new-inference");
        assert.equal(vault.get(serviceBinding), "new-tavily");
        assert.equal(fs.readFileSync(activePath, "utf8"), "hermes\n");
        const persisted = fs.readFileSync(configPath, "utf8");
        assert(!persisted.includes("new-inference"));
        assert(!persisted.includes("new-tavily"));
      } else {
        await assert.rejects(pending, /previous credentials were preserved/);
        assert.deepEqual(vault, initial);
        assert.equal(fs.readFileSync(configPath, "utf8"), previous);
        assert.equal(fs.readFileSync(activePath, "utf8"), "openclaw\n");
      }
      assert(released);
      assert(input.every((byte) => byte === 0));
      assert.deepEqual(fs.readdirSync(path.dirname(configPath)), ["native-windows.json"]);
    } finally {
      admit();
      t.mock.restoreAll();
      if (previousEnvironment === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = previousEnvironment;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test("malformed transaction keys fail before acquiring the state or mutating credentials", async () => {
  const malformed = Buffer.from('{"credentials":{"inference":"private-test-key"},invalid}');
  await assert.rejects(
    configureNativeFromStdin("unused", ["--transaction"], Readable.from([malformed])),
    { message: "NemoClaw native Windows launch failed: native setup configuration is invalid" },
  );
  assert(malformed.every((byte) => byte === 0));
  for (const invalid of [
    { inference: "new-inference", services: {} },
    { inference: "new-inference", services: { tavily: "new-tavily", brave: "extra" } },
    { inference: "new-inference", services: { tavily: "bad\nkey" } },
    { inference: "", services: { tavily: "key" } },
    { inference: "new-inference", services: [] },
  ]) {
    await assert.rejects(
      configureNativeFromStdin(
        "unused",
        ["--transaction"],
        Readable.from([Buffer.from(JSON.stringify({ configuration, credentials: invalid }))]),
        process.stdout,
        { acquireState: async () => assert.fail("invalid transaction acquired the state") },
      ),
      /native setup/,
    );
  }
});

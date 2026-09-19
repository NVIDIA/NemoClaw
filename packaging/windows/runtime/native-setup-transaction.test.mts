// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import {
  configureNativeFromStdin,
  type NativeOnboardingConfiguration,
} from "./native-setup-configuration.mts";
import { saveNativeOnboardingConfiguration } from "./run-installed-native-web-ui.mts";
import { nativeCredentialBinding } from "./native-security.mts";
import { NATIVE_SERVICES, nativeServiceBinding } from "./native-options.mts";

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

test("web onboarding uses the canonical lease and never persists its secret or launch action", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-web-configuration-lease-"));
  const previousLocalAppData = process.env.LOCALAPPDATA;
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
  const previous = {
    ...configuration,
    inference: "nvidia",
    endpoint: "https://integrate.api.nvidia.com/v1",
    options: { search: { provider: "tavily", credentialStored: true } },
  };
  const previousText = `${JSON.stringify(previous, null, 2)}\n`;
  const secret = "web-onboarding-secret";
  const webConfiguration: NativeOnboardingConfiguration = {
    agent: "hermes",
    inference: "compatible",
    endpoint: "https://example.invalid/v1",
    model: "new-model",
    credential: secret,
    options: {
      endpoint: "https://example.invalid/v1",
      model: "new-model",
      credential: secret,
      launch: "on",
      search: { provider: "tavily", credentialStored: true },
    },
  };
  let admit!: () => void;
  const admitted = new Promise<void>((resolve) => {
    admit = resolve;
  });
  let acquisitionStarted!: () => void;
  const acquiring = new Promise<void>((resolve) => {
    acquisitionStarted = resolve;
  });
  const events: string[] = [];
  const deletions: { provider: string; binding: string }[] = [];
  let submittedRecord: Record<string, unknown> | null = null;
  const configure: typeof configureNativeFromStdin = async (
    launcher,
    args = [],
    input = Readable.from([]),
  ) => {
    const chunks: Buffer[] = [];
    for await (const chunk of input) chunks.push(Buffer.from(chunk));
    const serialized = Buffer.concat(chunks).toString("utf8");
    const payload = JSON.parse(serialized);
    submittedRecord = payload.configuration;
    assert.equal(payload.credentials.inference, secret);
    assert(!JSON.stringify(submittedRecord).includes(secret));
    assert.deepEqual(args, ["--transaction"]);
    assert(!serialized.includes("launch"));
    events.push("configure");
    return await configureNativeFromStdin(
      launcher,
      args,
      Readable.from([Buffer.from(serialized)]),
      process.stdout,
      {
        acquireState: async (_launcher, agent) => {
          assert.equal(agent, "hermes");
          events.push("acquire");
          acquisitionStarted();
          await admitted;
          return {
            stateRoot: "C:\\NemoClawState-S-1-5-21-1-hermes",
            created: false,
            removed: false,
            assertHeld() {
              events.push("held");
            },
            async release() {
              events.push("release");
            },
          };
        },
        readCredential: async () => {
          events.push("credential");
          return secret;
        },
        readServices: async (_launcher, agent, options) => {
          assert.equal(agent, "hermes");
          assert.deepEqual(options, {
            search: { provider: "tavily", credentialStored: true },
          });
          events.push("services");
          return { options: {}, environment: {} };
        },
        deleteCredential: async (_launcher, provider, binding) => {
          events.push(`delete:${provider}`);
          deletions.push({ provider, binding });
        },
        credentialStore: {
          read: async () => "",
          write: async (_launcher, change) => {
            if (change.value) {
              assert.equal(change.value, secret);
              events.push("credential-write");
            } else {
              events.push(`delete:${change.provider}`);
              deletions.push({ provider: change.provider, binding: change.binding });
            }
          },
        },
      },
    );
  };
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, previousText);
    fs.writeFileSync(activePath, "openclaw\n");
    const pending = saveNativeOnboardingConfiguration("unused", webConfiguration, {
      configure,
    });
    await acquiring;
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ["configure", "acquire"]);
    assert.equal(fs.readFileSync(configPath, "utf8"), previousText);
    assert.equal(fs.readFileSync(activePath, "utf8"), "openclaw\n");
    assert.deepEqual((submittedRecord as { options?: unknown } | null)?.options, {
      search: { provider: "tavily", credentialStored: true },
    });
    admit();
    assert.equal(await pending, configPath);
    assert(events.indexOf("credential-write") > events.indexOf("held"));
    const persistedText = fs.readFileSync(configPath, "utf8");
    const persisted = JSON.parse(persistedText);
    assert.equal(persisted.agent, "hermes");
    assert.equal(persisted.inference, "compatible");
    assert.equal(persisted.credentialStored, true);
    assert.deepEqual(persisted.options, {
      search: { provider: "tavily", credentialStored: true },
    });
    assert(!persistedText.includes(secret));
    assert(!persistedText.includes("launch"));
    assert.equal(fs.readFileSync(activePath, "utf8"), "hermes\n");
    assert.deepEqual(deletions[0], {
      provider: "nvidia",
      binding: nativeCredentialBinding(previous),
    });
    assert.deepEqual(
      deletions.slice(1),
      Object.keys(NATIVE_SERVICES)
        .filter((provider) => provider !== "tavily")
        .map((provider) => ({
          provider,
          binding: nativeServiceBinding("hermes", provider),
        })),
    );
    assert.equal(events.at(-1), "release");
  } finally {
    admit();
    if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previousLocalAppData;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

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

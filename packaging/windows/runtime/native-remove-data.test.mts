// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { removeNativeAgentData } from "./native-remove-data.mts";
import { NATIVE_EXPRESS } from "./native-inference-manifest.mts";
import { NATIVE_LOCAL_MODELS } from "./native-local-models.mts";
import { NATIVE_SERVICES, nativeServiceBinding } from "./native-options.mts";
import { nativeCredentialBinding } from "./native-security.mts";
import { beginNativeConfigurationRecovery } from "./native-configuration-recovery.mts";

const hosted = {
  schemaVersion: 1,
  classification: "nemoclaw-native-windows-agent-configuration",
  agent: "openclaw",
  inference: "compatible",
  endpoint: "https://example.invalid/v1",
  model: "test-model",
  credentialStored: true,
  profile: "personal",
  options: {},
};
const selections = [
  { id: NATIVE_EXPRESS.id, model: NATIVE_EXPRESS.model },
  ...NATIVE_LOCAL_MODELS.models.map(({ id }) => ({ id, model: id })),
];

function fixture(t: TestContext, configuration: object, agent = "openclaw") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "native-removal-"));
  const previous = process.env.LOCALAPPDATA;
  // A double-leading slash is also absolute to path.win32 on the portable runner.
  process.env.LOCALAPPDATA = process.platform === "win32" ? directory : `/${directory}`;
  const root = path.join(directory, "NVIDIA", "NemoClaw");
  const selected = path.join(root, "agents", agent);
  const config = path.join(selected, "native-windows.json");
  const other = path.join(root, "agents", agent === "pi" ? "openclaw" : "pi", "retained.txt");
  const shared = path.join(root, "inference", "retained-model.gguf");
  fs.mkdirSync(selected, { recursive: true });
  fs.mkdirSync(path.dirname(other), { recursive: true });
  fs.mkdirSync(path.dirname(shared), { recursive: true });
  fs.writeFileSync(config, JSON.stringify(configuration));
  fs.writeFileSync(other, "other-agent");
  fs.writeFileSync(shared, "shared-model");
  const active = path.join(root, "active-agent.txt");
  fs.writeFileSync(active, agent + "\n");
  t.after(() => {
    if (previous === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { selected, config, other, shared, active };
}

function owner(expectedAgent = "openclaw") {
  const deleted: { provider: string; binding: string }[] = [];
  let held = false;
  let released = false;
  let acquired = 0;
  const dependencies = {
    acquireRemoval: async (_launcher: string, agent: string) => {
      assert.equal(agent, expectedAgent);
      acquired++;
      held = true;
      return {
        stateRoot: "C:\\NemoClawState-S-1-5-21-1-" + expectedAgent,
        created: false,
        removed: true,
        assertHeld() {
          assert(held);
        },
        async release() {
          held = false;
          released = true;
        },
      };
    },
    deleteCredential: async (_launcher: string, provider: string, binding: string) => {
      assert(held);
      deleted.push({ provider, binding });
    },
  };
  return { dependencies, deleted, acquired: () => acquired, released: () => released };
}

for (const agent of ["pi", "langchain-deepagents-code", "nemocua"]) {
  test(`retired ${agent} data remains removable without affecting another agent`, async (t) => {
    const configuration = { ...hosted, agent };
    const files = fixture(t, configuration, agent);
    const state = owner(agent);
    await removeNativeAgentData("unused", agent, state.dependencies);
    assert.deepEqual(state.deleted, [
      { provider: "compatible", binding: nativeCredentialBinding(configuration) },
      ...Object.keys(NATIVE_SERVICES).map((provider) => ({
        provider,
        binding: nativeServiceBinding(agent, provider),
      })),
    ]);
    assert.equal(fs.existsSync(files.selected), false);
    assert.equal(fs.existsSync(files.active), false);
    assert.equal(fs.readFileSync(files.other, "utf8"), "other-agent");
    assert.equal(fs.readFileSync(files.shared, "utf8"), "shared-model");
    assert.equal(state.released(), true);
  });
}

for (const selection of selections) {
  test(`removal accepts logical local model ${selection.id} without an external credential`, async (t) => {
    const { endpoint: _endpoint, ...metadata } = hosted;
    const files = fixture(t, {
      ...metadata,
      inference: "local",
      credentialStored: false,
      localModel: selection.id,
      model: selection.model,
    });
    const state = owner();
    await removeNativeAgentData("unused", "openclaw", state.dependencies);
    assert.deepEqual(
      state.deleted,
      Object.keys(NATIVE_SERVICES).map((provider) => ({
        provider,
        binding: nativeServiceBinding("openclaw", provider),
      })),
    );
    assert.equal(fs.existsSync(files.selected), false);
    assert.equal(fs.existsSync(files.active), false);
    assert.equal(fs.readFileSync(files.other, "utf8"), "other-agent");
    assert.equal(fs.readFileSync(files.shared, "utf8"), "shared-model");
    assert.equal(state.released(), true);
  });
}

test("hosted removal deletes its endpoint-bound key and preserves another active agent", async (t) => {
  const files = fixture(t, hosted);
  fs.writeFileSync(files.active, "pi\n");
  const state = owner();
  await removeNativeAgentData("unused", "openclaw", state.dependencies);
  assert.deepEqual(state.deleted[0], {
    provider: "compatible",
    binding: nativeCredentialBinding(hosted),
  });
  assert.equal(state.deleted.length, 1 + Object.keys(NATIVE_SERVICES).length);
  assert.equal(fs.existsSync(files.selected), false);
  assert.equal(fs.readFileSync(files.active, "utf8"), "pi\n");
  assert.equal(fs.readFileSync(files.other, "utf8"), "other-agent");
  assert.equal(fs.readFileSync(files.shared, "utf8"), "shared-model");
  assert.equal(state.released(), true);
});

test("removal cleans pending provider bindings under the selected agent owner", async (t) => {
  const files = fixture(t, hosted);
  const interrupted = {
    agent: "openclaw",
    inference: "nvidia",
    endpoint: "https://integrate.api.nvidia.com/v1",
  };
  beginNativeConfigurationRecovery(files.selected, "openclaw", [hosted, interrupted], () => {});
  const state = owner();
  await removeNativeAgentData("unused", "openclaw", state.dependencies);
  assert.deepEqual(state.deleted.slice(0, 2), [
    { provider: "compatible", binding: nativeCredentialBinding(hosted) },
    { provider: "nvidia", binding: nativeCredentialBinding(interrupted) },
  ]);
  assert.equal(state.deleted.length, 2 + Object.keys(NATIVE_SERVICES).length);
  assert.equal(state.released(), true);
  assert.equal(fs.existsSync(files.selected), false);
  assert.equal(fs.readFileSync(files.other, "utf8"), "other-agent");
  assert.equal(fs.readFileSync(files.shared, "utf8"), "shared-model");
});

test("foreign pending credential ownership rejects removal before deleting any state", async (t) => {
  const files = fixture(t, hosted);
  const record = beginNativeConfigurationRecovery(files.selected, "openclaw", [hosted], () => {});
  record.identities[0].agent = "hermes";
  fs.writeFileSync(
    path.join(files.selected, "native-configuration-pending.json"),
    JSON.stringify(record),
  );
  const state = owner();
  await assert.rejects(
    removeNativeAgentData("unused", "openclaw", state.dependencies),
    /credential owner is invalid/,
  );
  assert.equal(state.acquired(), 0);
  assert.deepEqual(state.deleted, []);
  assert.equal(fs.existsSync(files.config), true);
});

for (const [name, override] of [
  ["foreign model", { localModel: "unknown" }],
  ["mismatched model", { model: "foreign" }],
  ["external endpoint", { endpoint: hosted.endpoint }],
  ["stored credential", { credentialStored: true }],
  ["hosted provider", { inference: "compatible" }],
  ["wrong agent", { agent: "pi" }],
] as const) {
  test(`removal rejects ${name} before removing private state`, async (t) => {
    const { endpoint: _endpoint, ...metadata } = hosted;
    const files = fixture(t, {
      ...metadata,
      inference: "local",
      credentialStored: false,
      localModel: selections[0].id,
      model: selections[0].model,
      ...override,
    });
    const state = owner();
    await assert.rejects(removeNativeAgentData("unused", "openclaw", state.dependencies));
    assert.equal(state.acquired(), 0);
    assert.deepEqual(state.deleted, []);
    assert.equal(fs.existsSync(files.config), true);
    assert.equal(fs.readFileSync(files.active, "utf8"), "openclaw\n");
  });
}

test("removal reads the current credential binding after acquiring its state lease", async (t) => {
  const files = fixture(t, hosted);
  const state = owner();
  const latest = { ...hosted, endpoint: "https://updated.invalid/v1" };
  const acquire = state.dependencies.acquireRemoval;
  state.dependencies.acquireRemoval = async (...args) => {
    // A save completes while removal is opening the native state owner.
    fs.writeFileSync(files.config, JSON.stringify(latest));
    return await acquire(...args);
  };
  await removeNativeAgentData("unused", "openclaw", state.dependencies);
  assert.deepEqual(state.deleted[0], {
    provider: "compatible",
    binding: nativeCredentialBinding(latest),
  });
  assert.equal(state.released(), true);
});

test("failed credential cleanup preserves settings and releases the removal lease", async (t) => {
  const files = fixture(t, hosted);
  const state = owner();
  state.dependencies.deleteCredential = async () => {
    throw new Error("credential failure");
  };
  await assert.rejects(
    removeNativeAgentData("unused", "openclaw", state.dependencies),
    /credential failure/,
  );
  assert.equal(fs.existsSync(files.config), true);
  assert.equal(fs.readFileSync(files.active, "utf8"), "openclaw\n");
  assert.equal(state.released(), true);
});

for (const agent of ["openclaw", "hermes"]) {
  for (const failurePoint of ["directory", "directory-after-configuration", "active-selection"]) {
    test(`${agent} removal resumes after ${failurePoint} cleanup fails`, async (t) => {
      const configuration = { ...hosted, agent };
      const files = fixture(t, configuration, agent);
      const state = owner(agent);
      const bindings = new Set([
        nativeCredentialBinding(configuration),
        ...Object.keys(NATIVE_SERVICES).map((service) => nativeServiceBinding(agent, service)),
      ]);
      const deletion = state.dependencies.deleteCredential;
      state.dependencies.deleteCredential = async (...args) => {
        await deletion(...args);
        // CredDeleteW treats ERROR_NOT_FOUND as success. No credential read is needed.
        bindings.delete(args[2]);
      };
      fs.writeFileSync(path.join(files.selected, "retained-history"), "owned history");
      const remove = fs.rmSync.bind(fs);
      const removalError = new Error("owned metadata removal failure");
      const failure = t.mock.method(fs, "rmSync", (...args: Parameters<typeof fs.rmSync>) => {
        if (args[0] === (failurePoint === "active-selection" ? files.active : files.selected)) {
          if (failurePoint === "directory-after-configuration") fs.unlinkSync(files.config);
          throw removalError;
        }
        return remove(...args);
      });
      try {
        await assert.rejects(
          removeNativeAgentData("unused", agent, state.dependencies),
          (error: unknown) => {
            assert(error instanceof Error);
            assert.equal(error.cause, removalError);
            assert.match(error.message, new RegExp(`Removal of ${agent} data is incomplete`));
            assert.match(error.message, /credentials were removed/);
            assert.match(error.message, /retry data removal/);
            return true;
          },
        );
      } finally {
        failure.mock.restore();
      }
      assert.equal(bindings.size, 0);
      assert.equal(fs.existsSync(files.config), failurePoint === "directory");
      assert.equal(fs.readFileSync(files.active, "utf8"), agent + "\n");
      assert.equal(state.released(), true);
      await removeNativeAgentData("unused", agent, state.dependencies);
      assert.equal(state.acquired(), 2);
      assert.equal(bindings.size, 0);
      assert.equal(fs.existsSync(files.selected), false);
      assert.equal(fs.existsSync(files.active), false);
      assert.equal(fs.readFileSync(files.other, "utf8"), "other-agent");
      assert.equal(fs.readFileSync(files.shared, "utf8"), "shared-model");
      assert.equal(state.released(), true);
    });
  }
}

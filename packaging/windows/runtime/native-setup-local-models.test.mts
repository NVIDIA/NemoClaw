// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { test, after } from "node:test";
import {
  configureNativeFromStdin,
  normalizeOnboardingConfiguration,
} from "./native-setup-configuration.mts";
import { NATIVE_LOCAL_MODELS } from "./native-local-models.mts";
import { nativeCredentialBinding } from "./native-security.mts";
import { nativePackageFixture } from "../tests/native-package-fixture.mts";

const packageFixture = nativePackageFixture(after);

for (const model of NATIVE_LOCAL_MODELS.models) {
  const metadata = {
    schemaVersion: 1,
    id: model.id,
    model: model.id,
    modelRevision: model.revision,
    weightsSha256: model.weights.sha256,
    weightsBytes: model.weights.bytes,
    packSha256: "a".repeat(64),
    runtimeId: "b".repeat(64),
    runtimeManifestSha256: "c".repeat(64),
    sourceRevision: "d".repeat(40),
    availability: "download-on-setup",
    modelBytesRead: 0,
  };
  for (const agent of ["openclaw", "hermes"]) {
    const configuration = {
      schemaVersion: 1,
      classification: "nemoclaw-native-windows-agent-configuration",
      agent,
      inference: "local",
      localModel: model.id,
      model: model.id,
      credentialStored: false,
      profile: "personal",
      options: {},
    };
    test(`setup prepares ${agent} / ${model.id} without an external credential`, async () => {
      const normalized = normalizeOnboardingConfiguration(
        {
          agent,
          inference: "local",
          options: { localModel: model.id, model: model.id },
        },
        false,
      );
      assert.equal(normalized.localModel, model.id);
      assert.equal(normalized.endpoint, undefined);
      assert.equal(normalized.credential, "");
      let output = "";
      const input = Buffer.from(JSON.stringify(configuration));
      await configureNativeFromStdin(
        packageFixture.launcher,
        ["--prepare-all"],
        Readable.from([input]),
        {
          write: ((chunk: string) => {
            output += chunk;
            return true;
          }) as NodeJS.WriteStream["write"],
        },
        {
          inspectModel: async (_root, _launcher, selected) => {
            assert.equal(selected, model.id);
            return metadata;
          },
          acquireState: async () =>
            assert.fail("Preparation must not acquire or mutate agent state."),
        },
      );
      assert.deepEqual(JSON.parse(output), {
        schemaVersion: 1,
        inference: null,
        localModel: metadata,
        services: {},
      });
      assert(input.every((byte) => byte === 0));
    });

    for (const failure of [false, true]) {
      test(`setup ${agent} / ${model.id} ${failure ? "rolls back" : "commits"} under the existing lease`, async (t) => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-local-setup-"));
        const previousEnvironment = process.env.LOCALAPPDATA;
        process.env.LOCALAPPDATA = root;
        t.after(() => {
          if (previousEnvironment === undefined) delete process.env.LOCALAPPDATA;
          else process.env.LOCALAPPDATA = previousEnvironment;
          fs.rmSync(root, { recursive: true, force: true });
        });
        const configPath = path.join(
          root,
          "NVIDIA",
          "NemoClaw",
          "agents",
          agent,
          "native-windows.json",
        );
        const activePath = path.join(root, "NVIDIA", "NemoClaw", "active-agent.txt");
        const previous = {
          ...configuration,
          localModel: undefined,
          inference: "compatible",
          endpoint: "https://example.invalid/v1",
          model: "previous-model",
          credentialStored: true,
        };
        const previousText = JSON.stringify(previous);
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, previousText);
        fs.writeFileSync(activePath, "previous-agent\n");
        const previousBinding = nativeCredentialBinding(previous);
        const vault = new Map([[previousBinding, "previous-fixture-key"]]);
        let held = false;
        let released = false;
        let removals = 0;
        const input = Buffer.from(
          JSON.stringify({
            configuration,
            credentials: { inference: "", services: {} },
          }),
        );
        const result = configureNativeFromStdin(
          packageFixture.launcher,
          ["--transaction"],
          Readable.from([input]),
          process.stdout,
          {
            inspectModel: async (_root, _launcher, selected) => {
              assert.equal(selected, model.id);
              return metadata;
            },
            acquireState: async () => {
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
                if (change.value) vault.set(change.binding, change.value);
                else {
                  vault.delete(change.binding);
                  removals++;
                }
              },
            },
            readCredential: async () =>
              assert.fail("Managed local inference must not read an external provider key."),
            readServices: async () => {
              assert(held);
              assert(removals > 0);
              if (failure) throw new Error("fixture service verification failed");
              return { options: {}, environment: {} };
            },
          },
        );
        if (failure) {
          await assert.rejects(result, /previous credentials were preserved/u);
          assert.equal(fs.readFileSync(configPath, "utf8"), previousText);
          assert.equal(fs.readFileSync(activePath, "utf8"), "previous-agent\n");
          assert.equal(vault.get(previousBinding), "previous-fixture-key");
        } else {
          assert.equal(await result, configPath);
          const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));
          assert.equal(saved.localModel, model.id);
          assert.equal(saved.model, model.id);
          assert.equal(saved.credentialStored, false);
          assert.equal(saved.endpoint, undefined);
          assert.equal(fs.readFileSync(activePath, "utf8"), agent + "\n");
          assert.equal(vault.size, 0);
        }
        assert(released);
        assert(input.every((byte) => byte === 0));
        assert.deepEqual(fs.readdirSync(path.dirname(configPath)), ["native-windows.json"]);
      });
    }

    test(`setup rejects invalid ${agent} / ${model.id} selections before inspection or mutation`, async () => {
      for (const invalid of [
        { localModel: "foreign" },
        { model: "foreign" },
        { endpoint: "http://127.0.0.1:1" },
        { credentialStored: true },
        { inference: "compatible" },
      ]) {
        await assert.rejects(
          configureNativeFromStdin(
            packageFixture.launcher,
            ["--prepare-all"],
            Readable.from([Buffer.from(JSON.stringify({ ...configuration, ...invalid }))]),
            process.stdout,
            {
              inspectModel: async () => assert.fail("Invalid input reached model inspection."),
              acquireState: async () => assert.fail("Invalid input reached state acquisition."),
            },
          ),
          /configuration is invalid/u,
        );
      }
      assert.throws(
        () =>
          normalizeOnboardingConfiguration(
            {
              agent,
              inference: "local",
              options: { localModel: model.id, model: model.id, credential: "external-key" },
            },
            false,
          ),
        /without an endpoint or external key/u,
      );
    });
  }
}

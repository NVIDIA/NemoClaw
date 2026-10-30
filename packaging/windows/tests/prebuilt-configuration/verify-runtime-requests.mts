// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { nativePackageFixture } from "../native-package-fixture.mts";
import {
  configureNativeFromStdin,
  readNativeAgentConfiguration,
} from "../../runtime/native-setup-configuration.mts";
import { NATIVE_EXPRESS } from "../../runtime/native-inference-manifest.mts";
import { NATIVE_LOCAL_MODELS } from "../../runtime/native-local-models.mts";

const evidence = JSON.parse(fs.readFileSync(process.argv[2], "utf8").replace(/^\uFEFF/u, ""));
assert.equal(evidence.failed, 0);
assert(evidence.passed > 0);
const expected = ["openclaw", "hermes"].flatMap((agent) =>
  ["hosted", NATIVE_EXPRESS.id, ...NATIVE_LOCAL_MODELS.models.map((model) => model.id)].map(
    (choice) => agent + ":" + choice,
  ),
);
assert.deepEqual(
  evidence.requests
    .map(
      (request: { agent: string; localModel?: string }) =>
        request.agent + ":" + (request.localModel ?? "hosted"),
    )
    .sort(),
  expected.sort(),
);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrapper-runtime-input-"));
const prior = process.env.LOCALAPPDATA;
process.env.LOCALAPPDATA = root;
let cleanupPackage = () => {};
const packageFixture = nativePackageFixture((cleanup) => {
  cleanupPackage = cleanup;
});
try {
  for (const request of evidence.requests) {
    assert.equal(request.kind, "native-setup-request");
    for (const field of ["schemaVersion", "classification", "profile", "credential"])
      assert(!Object.hasOwn(request, field));
    const secret = request.credentialStored ? "nvapi-bootstrapper-fixture" : "";
    let held = false,
      released = false;
    const input = Buffer.from(
      JSON.stringify({
        configuration: request,
        credentials: { inference: secret, services: {} },
      }),
    );
    const result = await configureNativeFromStdin(
      packageFixture.launcher,
      ["--transaction"],
      Readable.from([input]),
      process.stdout,
      {
        lookupEndpoint: async () => [{ address: "8.8.8.8", family: 4 }],
        inspectModel: async (_root, _launcher, id) => {
          assert.equal(id, request.localModel);
          const model = NATIVE_LOCAL_MODELS.models.find((item) => item.id === id);
          assert(model || id === NATIVE_EXPRESS.id);
          return {
            schemaVersion: 1 as const,
            id,
            model: model?.id ?? NATIVE_EXPRESS.model,
            modelRevision: model?.revision ?? NATIVE_EXPRESS.modelRevision,
            weightsSha256: (model?.weights ?? NATIVE_EXPRESS.weights).sha256,
            weightsBytes: (model?.weights ?? NATIVE_EXPRESS.weights).bytes,
            packSha256: "a".repeat(64),
            runtimeId: "b".repeat(64),
            runtimeManifestSha256: "c".repeat(64),
            sourceRevision: "d".repeat(40),
            availability: model ? ("download-on-setup" as const) : ("prebuilt" as const),
            modelBytesRead: 0 as const,
          };
        },
        acquireState: async () => {
          held = true;
          return {
            stateRoot: root,
            created: false,
            removed: false,
            assertHeld: () => assert(held),
            release: async () => {
              held = false;
              released = true;
            },
          };
        },
        credentialStore: {
          read: async () => {
            assert(held);
            return "";
          },
          write: async () => {
            assert(held);
          },
        },
        readCredential: async () => {
          assert(held);
          return secret;
        },
        readServices: async () => {
          assert(held);
          return { options: {}, environment: {} };
        },
      },
    );
    assert(released);
    assert(input.every((byte) => byte === 0));
    const { config } = readNativeAgentConfiguration(request.agent);
    assert.deepEqual(config, {
      schemaVersion: 1,
      classification: "nemoclaw-native-windows-agent-configuration",
      profile: "personal",
      agent: request.agent,
      inference: request.inference,
      model: request.model,
      credentialStored: request.credentialStored,
      options: {},
      ...(request.localModel ? { localModel: request.localModel } : { endpoint: request.endpoint }),
    });
    assert.equal(
      result,
      path.join(root, "NVIDIA", "NemoClaw", "agents", request.agent, "native-windows.json"),
    );
    assert(!fs.readFileSync(result!, "utf8").includes("nvapi-bootstrapper-fixture"));
    for (const metadata of [
      { schemaVersion: 1 },
      { classification: "nemoclaw-native-windows-agent-configuration" },
      { profile: "personal" },
      { kind: "foreign" },
    ]) {
      await assert.rejects(
        configureNativeFromStdin(
          packageFixture.launcher,
          ["--prepare-all"],
          Readable.from([Buffer.from(JSON.stringify({ ...request, ...metadata }))]),
          process.stdout,
          {
            inspectModel: async () => assert.fail("Invalid input reached model inspection."),
            acquireState: async () => assert.fail("Invalid input reached state acquisition."),
          },
        ),
        /configuration is invalid/u,
      );
    }
  }
} finally {
  cleanupPackage();
  if (prior === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = prior;
  fs.rmSync(root, { recursive: true, force: true });
}
assert(!fs.existsSync(root));
console.log(
  JSON.stringify({
    passed: true,
    requests: expected.length,
    bootstrapperRuntimeInterop: true,
    installedAcceptance: false,
    cleanup: true,
  }),
);

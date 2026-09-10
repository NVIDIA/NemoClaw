// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { configureNativeFromStdin } from "./native-setup-configuration.mts";
import { nativeCredentialBinding } from "./native-security.mts";
import { nativeServiceBinding } from "./native-options.mts";
import { NATIVE_EXPRESS } from "./native-inference-manifest.mts";

const configuration = {
  schemaVersion: 1,
  classification: "nemoclaw-native-windows-agent-configuration",
  agent: "hermes",
  inference: "nvidia",
  endpoint: "https://integrate.api.nvidia.com/v1",
  model: "test-model",
  credentialStored: true,
  profile: "personal",
  options: {
    search: { provider: "tavily", credentialStored: true },
    messaging: { telegram: { credentialStored: true, allowedUsers: ["123456"] } },
  },
};

async function prepare(value: unknown, args = ["--prepare-all"]): Promise<string> {
  let result = "";
  await configureNativeFromStdin(
    "nonexistent-credential-helper",
    args,
    Readable.from([Buffer.from(JSON.stringify(value))]),
    {
      write: ((chunk: string | Uint8Array) => {
        result += chunk.toString();
        return true;
      }) as NodeJS.WriteStream["write"],
    },
  );
  return result;
}

test("one metadata-only call returns all selected existing credential identities", async () => {
  assert.deepEqual(JSON.parse(await prepare(configuration)), {
    schemaVersion: 1,
    inference: nativeCredentialBinding(configuration),
    services: {
      tavily: nativeServiceBinding("hermes", "tavily"),
      telegram: nativeServiceBinding("hermes", "telegram"),
    },
  });
  assert.equal(await prepare(configuration, ["--prepare"]), nativeCredentialBinding(configuration));
});

test("invalid or missing credentials fail before emitting a preparation result", async () => {
  await assert.rejects(
    prepare({ ...configuration, credentialStored: false }),
    /requires a credential/u,
  );
  await assert.rejects(
    prepare({
      ...configuration,
      options: { search: { provider: "brave", credentialStored: true } },
    }),
    /does not support/u,
  );
  await assert.rejects(
    prepare({
      ...configuration,
      options: { messaging: { telegram: { credentialStored: true, allowedUsers: ["invalid"] } } },
    }),
    /valid messaging/u,
  );
});

test("custom provider bindings retain the broker endpoint security boundary", async () => {
  await assert.rejects(
    prepare({
      ...configuration,
      inference: "compatible",
      endpoint: "https://user:password@example.invalid/v1",
    }),
    /endpoint violates/u,
  );
  const local = {
    ...configuration,
    inference: "local",
    endpoint: "http://127.0.0.1:12345/v1",
    credentialStored: false,
    options: {},
  };
  assert.deepEqual(JSON.parse(await prepare(local)), {
    schemaVersion: 1,
    inference: nativeCredentialBinding(local),
    services: {},
  });
});

test("metadata input is bounded before parsing or credential access", async () => {
  await assert.rejects(prepare({ ...configuration, model: "x".repeat(17 * 1024) }), /size limit/u);
});

test("logical prebuilt model preparation emits no endpoint or external credential binding", async () => {
  const local = {
    ...configuration,
    inference: "local",
    endpoint: undefined,
    model: NATIVE_EXPRESS.model,
    credentialStored: false,
    localModel: NATIVE_EXPRESS.id,
    options: {},
  };
  const metadata = {
    schemaVersion: 1,
    id: NATIVE_EXPRESS.id,
    model: NATIVE_EXPRESS.model,
    modelRevision: NATIVE_EXPRESS.modelRevision,
    weightsSha256: NATIVE_EXPRESS.weights.sha256,
    weightsBytes: NATIVE_EXPRESS.weights.bytes,
    packSha256: "a".repeat(64),
    runtimeId: "b".repeat(64),
    runtimeManifestSha256: "c".repeat(64),
    sourceRevision: "d".repeat(40),
    availability: "prebuilt" as const,
    modelBytesRead: 0 as const,
  };
  let inspections = 0;
  let text = "";
  await configureNativeFromStdin(
    "unused-native-credential-helper",
    ["--prepare-all"],
    Readable.from([Buffer.from(JSON.stringify(local))]),
    {
      write: ((chunk: string) => {
        text += chunk;
        return true;
      }) as NodeJS.WriteStream["write"],
    },
    {
      inspectModel: async () => {
        inspections++;
        return metadata;
      },
    },
  );
  assert.equal(inspections, 1);
  assert.deepEqual(JSON.parse(text), {
    schemaVersion: 1,
    inference: null,
    localModel: metadata,
    services: {},
  });
  assert.equal(text.includes("endpoint"), false);
});

test("a local-model endpoint placeholder is rejected before inspecting a pack", async () => {
  let called = false;
  await assert.rejects(
    configureNativeFromStdin(
      "unused",
      ["--prepare-all"],
      Readable.from([
        Buffer.from(
          JSON.stringify({
            ...configuration,
            inference: "local",
            endpoint: "http://127.0.0.1:1",
            model: NATIVE_EXPRESS.model,
            credentialStored: false,
            localModel: NATIVE_EXPRESS.id,
            options: {},
          }),
        ),
      ]),
      process.stdout,
      {
        inspectModel: async () => {
          called = true;
          throw new Error("must not inspect");
        },
      },
    ),
    /configuration is invalid/u,
  );
  assert.equal(called, false);
});

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { parse as parseYaml } from "yaml";
import { configureNativeFromStdin } from "./native-setup-configuration.mts";
import { nativeCredentialBinding } from "./native-security.mts";
import { nativeServiceBinding } from "./native-options.mts";
import { NATIVE_EXPRESS } from "./native-inference-manifest.mts";
import { interactiveWorkloadSource } from "./run-installed-native-console-agent.mts";
import type { NativeOptions } from "./native-options.mts";

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

function writeGeneratedHermesConfiguration(home: string, options: NativeOptions) {
  // Execute only the actual prebuilt worker's configuration writer. No worker
  // startup, interpreter, credentials, provider, or network operation is run.
  const source = interactiveWorkloadSource();
  const declaration = source.indexOf("const nativeHermesConfiguration = ");
  const declarationEnd = source.indexOf("\n\nconst required = ", declaration);
  const writer = source.indexOf('writeFileSync(join(hermesHome, "config.yaml"),');
  const writerEnd = source.indexOf("  const runner = ", writer);
  assert(declaration >= 0 && declarationEnd > declaration && writer >= 0 && writerEnd > writer);
  runInNewContext(
    source.slice(declaration, declarationEnd) + "\n" + source.slice(writer, writerEnd),
    {
      writeFileSync: fs.writeFileSync,
      join: path.join,
      hermesHome: home,
      model: "test-model",
      baseUrl: "http://127.0.0.1:1/v1",
      brokerToken: "",
      nativeServices: { options },
    },
  );
  return parseYaml(fs.readFileSync(path.join(home, "config.yaml"), "utf8"));
}

test("unchecked Hermes search replaces persisted enables with the stable disabled-web contract", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "native-hermes-search-off-"));
  try {
    fs.writeFileSync(
      path.join(home, "config.yaml"),
      JSON.stringify({
        web: { backend: "tavily", keyless_fallback: true },
        agent: { disabled_toolsets: [] },
        platform_toolsets: { cli: ["hermes-cli", "web"], slack: ["web"] },
      }),
    );
    const actual = writeGeneratedHermesConfiguration(home, {});
    // v2026.9.7: web_search_registry reads keyless_fallback; the final
    // model_tools selection subtracts agent.disabled_toolsets after enables.
    assert.deepEqual(actual.web, { keyless_fallback: false });
    assert.deepEqual(actual.agent.disabled_toolsets, ["web"]);
    assert.equal(actual.platform_toolsets, undefined);
    assert.equal(actual.agent.disabled_toolsets.includes("browser"), false);
    assert.equal(actual.security.allow_lazy_installs, false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Tavily selection clears previous suppression and preserves existing Hermes YAML semantics", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "native-hermes-search-on-"));
  try {
    writeGeneratedHermesConfiguration(home, {});
    const actual = writeGeneratedHermesConfiguration(home, {
      search: { provider: "tavily", credentialStored: true },
      messaging: { telegram: { credentialStored: true, allowedUsers: [] } },
    });
    assert.deepEqual(actual, {
      model: {
        default: "test-model",
        provider: "custom",
        base_url: "http://127.0.0.1:1/v1",
        api_key: "",
        context_length: 131072,
      },
      web: { backend: "tavily", search_backend: "tavily", extract_backend: "tavily" },
      platforms: { telegram: { enabled: true } },
      memory: { memory_enabled: true, user_profile_enabled: true },
      security: { allow_lazy_installs: false },
      updates: { check: false, pre_update_backup: false, refresh_cua_driver: false },
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

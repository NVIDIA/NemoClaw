// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { HOSTED_NATIVE_PROVIDERS } from "../../src/lib/inference/native-provider/hosted.ts";
import {
  NVIDIA_HOSTED_CREDENTIAL_ENV,
  NVIDIA_HOSTED_LOGICAL_PROVIDER,
  NVIDIA_HOSTED_NATIVE_ENDPOINT,
} from "../../src/lib/inference/native-nvidia/contract.ts";

// Exercise the installed, pinned Pi resolver during image construction. No provider calls or keys.
const runtime =
  process.argv[2] ??
  "/usr/local/lib/nemoclaw/pi-runtime/node_modules/@earendil-works/pi-coding-agent";
const {
  clearConfigValueCache,
  resolveConfigValue,
  resolveHeadersOrThrow,
  getMissingConfigValueEnvVarNames,
} = await import(pathToFileURL(join(runtime, "dist/core/resolve-config-value.js")).href);
for (const provider of [
  ...HOSTED_NATIVE_PROVIDERS.filter((item) => item.api === "openai-completions"),
  {
    logicalProvider: NVIDIA_HOSTED_LOGICAL_PROVIDER,
    endpoint: NVIDIA_HOSTED_NATIVE_ENDPOINT,
    credentialEnv: NVIDIA_HOSTED_CREDENTIAL_ENV,
  },
]) {
  const home = mkdtempSync(join(tmpdir(), "pi-native-credential-"));
  try {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("./generate-config.ts", import.meta.url))],
      {
        encoding: "utf8",
        env: {
          HOME: home,
          NEMOCLAW_MODEL: "synthetic-model",
          NEMOCLAW_UPSTREAM_PROVIDER: provider.logicalProvider,
          NEMOCLAW_INFERENCE_BASE_URL: provider.endpoint,
          [provider.credentialEnv]: "synthetic-build-secret",
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const text = readFileSync(join(home, ".pi/agent/models.json"), "utf8");
    const key = JSON.parse(text).providers.openshell.apiKey;
    for (const scope of ["v7", "v8", `s${"a".repeat(64)}`]) {
      const handle = `openshell:resolve:env:${scope}_${provider.credentialEnv}`;
      assert.equal(
        resolveConfigValue(key, { [provider.credentialEnv]: handle }),
        handle,
        provider.logicalProvider,
      );
      assert.equal(text.includes(handle), false);
    }
    assert.equal(text.includes("synthetic-build-secret"), false);
    // A missing injected value must not fall back to an unscoped resolver alias.
    delete process.env[provider.credentialEnv];
    assert.equal(resolveConfigValue(key, {}), undefined);
    assert.deepEqual(getMissingConfigValueEnvVarNames(key, {}), [provider.credentialEnv]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const nativeHome = mkdtempSync(join(tmpdir(), "pi-native-local-credential-"));
try {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./generate-config.ts", import.meta.url))],
    {
      encoding: "utf8",
      env: {
        HOME: nativeHome,
        NEMOCLAW_MODEL: "synthetic-local-model",
        NEMOCLAW_UPSTREAM_PROVIDER: "compatible-endpoint",
        NEMOCLAW_INFERENCE_BASE_URL: "http://host.openshell.internal:11434/v1",
        NEMOCLAW_LOCAL_INFERENCE_TOKEN: "raw-build-secret-must-not-be-written",
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const text = readFileSync(join(nativeHome, ".pi/agent/models.json"), "utf8");
  assert.equal(text.includes("raw-build-secret-must-not-be-written"), false);
  const provider = JSON.parse(text).providers.openshell;
  for (const scope of ["v7", `s${"a".repeat(64)}`]) {
    const handle = `openshell:resolve:env:${scope}_NEMOCLAW_LOCAL_INFERENCE_TOKEN`;
    process.env.NEMOCLAW_LOCAL_INFERENCE_TOKEN = handle;
    clearConfigValueCache();
    assert.equal(resolveConfigValue(provider.apiKey), handle);
    assert.equal(
      resolveHeadersOrThrow(provider.headers, "Pi native-local request").Authorization,
      `Bearer ${handle}`,
    );
    assert.equal(text.includes(handle), false);
  }
  delete process.env.NEMOCLAW_LOCAL_INFERENCE_TOKEN;
  clearConfigValueCache();
  assert.equal(resolveConfigValue(provider.apiKey), undefined);
  assert.throws(() => resolveHeadersOrThrow(provider.headers, "Pi native-local request"));

  const settingsPath = join(nativeHome, ".pi/agent/settings.json");
  writeFileSync(
    settingsPath,
    '{"defaultProvider":"openshell","defaultModel":"old-model","futurePiSetting":true}\n',
  );
  const switched = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./generate-config.ts", import.meta.url))],
    {
      encoding: "utf8",
      env: {
        HOME: nativeHome,
        NEMOCLAW_MODEL: "switched-local-model",
        NEMOCLAW_UPSTREAM_PROVIDER: "compatible-endpoint",
        NEMOCLAW_INFERENCE_BASE_URL: "http://host.openshell.internal:11434/v1",
      },
    },
  );
  assert.equal(switched.status, 0, switched.stderr);
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {
    defaultProvider: "openshell",
    defaultModel: "switched-local-model",
    futurePiSetting: true,
  });
} finally {
  delete process.env.NEMOCLAW_LOCAL_INFERENCE_TOKEN;
  clearConfigValueCache();
  rmSync(nativeHome, { recursive: true, force: true });
}
console.log("Pi native credential resolution passed for hosted and local providers.");

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { HOSTED_NATIVE_PROVIDERS } from "../../src/lib/inference/native-provider/hosted.ts";

// Exercise the installed, pinned Pi resolver during image construction. No provider calls or keys.
const runtime =
  process.argv[2] ??
  "/usr/local/lib/nemoclaw/pi-runtime/node_modules/@earendil-works/pi-coding-agent";
const { resolveConfigValue, getMissingConfigValueEnvVarNames } = await import(
  pathToFileURL(join(runtime, "dist/core/resolve-config-value.js")).href
);
for (const provider of HOSTED_NATIVE_PROVIDERS.filter(
  (item) => item.api === "openai-completions",
)) {
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
    const handle = `openshell:resolve:env:v7_${provider.credentialEnv}`;
    assert.equal(
      resolveConfigValue(key, { [provider.credentialEnv]: handle }),
      handle,
      provider.logicalProvider,
    );
    assert.equal(text.includes("synthetic-build-secret"), false);
    assert.equal(text.includes(handle), false);
    // A missing injected value must not fall back to an unscoped resolver alias.
    delete process.env[provider.credentialEnv];
    assert.equal(resolveConfigValue(key, {}), undefined);
    assert.deepEqual(getMissingConfigValueEnvVarNames(key, {}), [provider.credentialEnv]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
console.log("Pi native credential resolution passed for four hosted providers.");

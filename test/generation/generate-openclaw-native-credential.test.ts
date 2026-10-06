// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { buildConfig } from "../../scripts/generate-openclaw-config.mts";
import { NATIVE_HOSTED_PROFILES } from "../../src/lib/inference/native-hosted/profiles";
import { baseOpenClawGenerationEnv, buildOpenClawTestEnv } from "../helpers/openclaw-env-fixture";
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "native-openclaw-config-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));
function buildConfigDirect(overrides: Record<string, string>) {
  return buildConfig(buildOpenClawTestEnv(home, baseOpenClawGenerationEnv(), overrides)) as {
    models: { providers: { inference: { apiKey: string } } };
  };
}
describe("native OpenClaw credential generation", () => {
  it.each(NATIVE_HOSTED_PROFILES)(
    "generates only a workload env reference for $label native endpoint",
    (profile) => {
      const env = {
        NEMOCLAW_UPSTREAM_PROVIDER: profile.logicalProvider,
        NEMOCLAW_INFERENCE_PROVIDER_ID: "inference",
        NEMOCLAW_INFERENCE_BASE_URL: profile.endpoint,
        [profile.credentialEnv]: "raw-value-must-not-enter-config",
      };
      const config = buildConfigDirect(env);
      expect(config.models.providers.inference.apiKey).toBe(`\${${profile.credentialEnv}}`);
      expect(JSON.stringify(config)).not.toContain("raw-value-must-not-enter-config");
      expect(
        buildConfigDirect({ ...env, NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1" })
          .models.providers.inference.apiKey,
      ).toBe("unused");
    },
  );
});

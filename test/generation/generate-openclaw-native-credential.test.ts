// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { buildConfig } from "../../scripts/generate-openclaw-config.mts";
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
  it.each(["compatible-endpoint", "compatible-anthropic-endpoint"])(
    "uses a runtime credential environment reference for native %s",
    (provider) => {
      const config = buildConfigDirect({
        NEMOCLAW_UPSTREAM_PROVIDER: provider,
        NEMOCLAW_INFERENCE_PROVIDER_ID: "inference",
        NEMOCLAW_INFERENCE_BASE_URL: "https://api.example.com/v1",
        NEMOCLAW_COMPATIBLE_INFERENCE_API_KEY: "raw-credential-canary",
      });
      expect(config.models.providers.inference.apiKey).toBe(
        "${NEMOCLAW_COMPATIBLE_INFERENCE_API_KEY}",
      );
      expect(JSON.stringify(config)).not.toContain("raw-credential-canary");
    },
  );

  it("accepts normalized provider whitespace and uppercase HTTPS schemes", () => {
    const config = buildConfigDirect({
      NEMOCLAW_UPSTREAM_PROVIDER: " compatible-endpoint ",
      NEMOCLAW_INFERENCE_PROVIDER_ID: "inference",
      NEMOCLAW_INFERENCE_BASE_URL: "HTTPS://api.example.com/v1",
    });
    expect(config.models.providers.inference.apiKey).toBe(
      "${NEMOCLAW_COMPATIBLE_INFERENCE_API_KEY}",
    );
  });

  it("uses the NVIDIA runtime handle reference only on its native endpoint", () => {
    const config = buildConfigDirect({
      NEMOCLAW_UPSTREAM_PROVIDER: "nvidia-prod",
      NEMOCLAW_INFERENCE_PROVIDER_ID: "inference",
      NEMOCLAW_INFERENCE_BASE_URL: "https://integrate.api.nvidia.com/v1",
      NVIDIA_INFERENCE_API_KEY: "raw-nvidia-canary",
    });
    expect(config.models.providers.inference.apiKey).toBe("${NVIDIA_INFERENCE_API_KEY}");
    expect(JSON.stringify(config)).not.toContain("raw-nvidia-canary");
  });

  it("retains the shared-route sentinel for host-local compatible inference", () => {
    const config = buildConfigDirect({
      NEMOCLAW_UPSTREAM_PROVIDER: "compatible-endpoint",
      NEMOCLAW_INFERENCE_PROVIDER_ID: "inference",
      NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
    });
    expect(config.models.providers.inference.apiKey).toBe("unused");
  });
});

it.each([11436, 21436])("uses a scoped Bedrock adapter token reference at port %s", (port) => {
  const config = buildConfigDirect({
    NEMOCLAW_UPSTREAM_PROVIDER: "compatible-anthropic-endpoint",
    NEMOCLAW_INFERENCE_PROVIDER_ID: "inference",
    NEMOCLAW_INFERENCE_BASE_URL: `http://host.openshell.internal:${port}/v1`,
    NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_TOKEN: "RAW-ADAPTER-TOKEN-MUST-NOT-ENTER-CONFIG",
  });
  expect(config.models.providers.inference.apiKey).toBe(
    "${NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_TOKEN}",
  );
  expect(JSON.stringify(config)).not.toContain("RAW-ADAPTER-TOKEN-MUST-NOT-ENTER-CONFIG");
});
it.each([
  ["compatible-endpoint", "http://host.openshell.internal:11436/v1"],
  ["compatible-anthropic-endpoint", "http://other.internal:11436/v1"],
  ["compatible-anthropic-endpoint", "http://host.openshell.internal:11436/other"],
  ["compatible-anthropic-endpoint", "https://host.openshell.internal:11436/v1"],
])("does not select the Bedrock token for %s at %s", (provider, endpoint) => {
  const config = buildConfigDirect({
    NEMOCLAW_UPSTREAM_PROVIDER: provider,
    NEMOCLAW_INFERENCE_PROVIDER_ID: "inference",
    NEMOCLAW_INFERENCE_BASE_URL: endpoint,
  });
  expect(config.models.providers.inference.apiKey).not.toBe(
    "${NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_TOKEN}",
  );
});

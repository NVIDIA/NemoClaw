// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
const PROTOTYPE = join(ROOT, "scripts", "hermes-switchyard-inference-local-prototype");
const README = readFileSync(join(PROTOTYPE, "README.md"), "utf8");
const PLUGINS = readFileSync(join(PROTOTYPE, "plugins.toml"), "utf8");
const RUNNER = readFileSync(join(PROTOTYPE, "run.mts"), "utf8");
const SANDBOX_RUNNER = readFileSync(join(PROTOTYPE, "run-in-sandbox.sh"), "utf8");
const BASE_IMAGE_RUNTIME = readFileSync(join(ROOT, "src", "lib", "agent", "base-image.ts"), "utf8");
const SANDBOX_PREBUILD = readFileSync(
  join(ROOT, "src", "lib", "onboard", "sandbox-prebuild.ts"),
  "utf8",
);
const FINAL_DOCKERFILE = readFileSync(join(ROOT, "agents", "hermes", "Dockerfile"), "utf8");

describe("Hermes Relay Switchyard inference.local prototype", () => {
  it("preserves all three architecture iterations with immutable V1 and V2 identities (#7937)", () => {
    expect(README).toContain("codex/switchyard-relay-prototype-v1");
    expect(README).toContain("`d58276ab7`");
    expect(README).toContain("codex/switchyard-relay-prototype-v2");
    expect(README).toContain("`3c6932bdd`");
    expect(README).toContain("codex/switchyard-relay-prototype-v3");
    expect(README).toMatch(/does not\s+rewrite either earlier branch/u);
    expect(README).toContain("Hermes #77915");
    expect(README).toContain("Switchyard #270");
  });

  it("maps only final targets through inference.local without credential configuration (#7937)", () => {
    expect(PLUGINS.match(/base_url = "http:\/\/127\.0\.0\.1:4101"/g)).toHaveLength(1);
    expect(PLUGINS.match(/base_url = "https:\/\/inference\.local"/g)).toHaveLength(2);
    expect(PLUGINS).toContain('kind = "llm_classifier"');
    expect(PLUGINS).toContain('weak_target = "fast"');
    expect(PLUGINS).toContain('strong_target = "quality"');
    expect(PLUGINS).not.toMatch(/header_env|authorization|api[_-]?key|secret/i);
    expect(PLUGINS).not.toContain("switchyard-server");
  });

  // source-shape-contract: security -- The separate V3 selector must imply the reviewed native upstream bundle and install only the inference.local target configuration and verifier
  it("makes V3 imply the native V2 inputs while retaining a separate selector (#7937)", () => {
    expect(BASE_IMAGE_RUNTIME).toContain("NEMOCLAW_HERMES_SWITCHYARD_INFERENCE_LOCAL_PROTOTYPE");
    expect(BASE_IMAGE_RUNTIME).toContain('HERMES_VERSION: "v2026.8.3"');
    expect(BASE_IMAGE_RUNTIME).toContain("activateHermesSwitchyardPrototypeDockerfile");
    expect(BASE_IMAGE_RUNTIME).toContain("`ARG ${name}=${value}`");
    expect(SANDBOX_PREBUILD).toContain('"NEMOCLAW_HERMES_SWITCHYARD_INFERENCE_LOCAL_PROTOTYPE=1"');
    expect(SANDBOX_PREBUILD).toContain('"NEMOCLAW_HERMES_SWITCHYARD_NATIVE_PROTOTYPE=1"');
    expect(FINAL_DOCKERFILE).toContain("ARG NEMOCLAW_HERMES_SWITCHYARD_INFERENCE_LOCAL_PROTOTYPE");
    expect(FINAL_DOCKERFILE).toContain(
      "/usr/local/lib/nemoclaw/switchyard-inference-local-run-in-sandbox.sh",
    );
    expect(FINAL_DOCKERFILE).toContain(
      "/usr/local/lib/nemoclaw/switchyard-relay-plugin/plugins.toml",
    );
  });

  it("proves the provider and process boundaries from inside the managed sandbox (#7937)", () => {
    for (const credential of [
      "NVIDIA_API_KEY",
      "NVIDIA_INFERENCE_API_KEY",
      "OPENAI_API_KEY",
      "OPENROUTER_API_KEY",
      "ANTHROPIC_API_KEY",
      "COMPATIBLE_API_KEY",
    ]) {
      expect(SANDBOX_RUNNER).toContain(credential);
    }
    expect(SANDBOX_RUNNER).toContain("https://inference.local/v1/chat/completions");
    expect(SANDBOX_RUNNER).toContain("auth_probe_value_prefix='nemoclaw-v3-untrusted-'");
    expect(SANDBOX_RUNNER).toContain('auth_probe_value="${auth_probe_value_prefix}caller-value"');
    expect(RUNNER).toContain("nemoclaw-v3-untrusted-caller-value");
    expect(SANDBOX_RUNNER).toContain("^openshell:resolve:env:(v[0-9]{1,20}_)?COMPATIBLE_API_KEY$");
    expect(SANDBOX_RUNNER).toContain('"raw_provider_credentials_absent": True');
    expect(SANDBOX_RUNNER).toContain('"provider_placeholder_present": True');
    expect(SANDBOX_RUNNER).toContain("gateway_pid_before");
    expect(SANDBOX_RUNNER).toContain("gateway_pid_after");
    expect(SANDBOX_RUNNER).toContain("relay_sidecars");
    expect(SANDBOX_RUNNER).toContain('models != ["provider/classifier", "provider/classifier"]');
    expect(SANDBOX_RUNNER).not.toContain("nemo-relay run");
  });

  it("reports the single-forced-model limitation instead of claiming two real tiers (#7937)", () => {
    expect(README).toContain("gateway-forced-single-model");
    expect(README).toMatch(/does not\s+claim simultaneous real weak\/strong routing/u);
    expect(RUNNER).toContain('route_model_contract !== "gateway-forced-single-model"');
    expect(RUNNER).toContain('models.has("nemoclaw-switchyard-efficient")');
    expect(RUNNER).toContain('models.has("nemoclaw-switchyard-capable")');
    expect(RUNNER).toContain("--provider-log");
    expect(RUNNER).toContain("constants.O_NOFOLLOW");
    expect(RUNNER).not.toContain("gateway-authenticated requests: ${raw}");
  });

  it("rejects an incomplete invocation before touching a sandbox (#7937)", () => {
    const usage = spawnSync(process.execPath, [join(PROTOTYPE, "run.mts")], {
      encoding: "utf8",
    });
    expect(usage.status).toBe(2);
    expect(usage.stderr).toContain(
      "npm run prototype:hermes-switchyard:inference-local -- <sandbox-name> [--restart] [--provider-log <absolute-path>]",
    );
  });
});

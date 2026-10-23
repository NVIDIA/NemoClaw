// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyHermesManagedRoute } from "../../../src/lib/hermes-managed-route";
import {
  createRestartFixture,
  hashInputs,
  mode,
  runWriteConfig,
  strictHashIsValid,
} from "../../helpers/hermes-restart-config-seal-fixture";

const route = {
  upstreamProvider: "vllm-local",
  baseUrl: "http://host.openshell.internal:8000/v1",
  inferenceApi: "openai-completions",
  model: "selected-model",
};
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const issued = (scope: string) => `openshell:resolve:env:${scope}_NEMOCLAW_LOCAL_INFERENCE_TOKEN`;

describe.skipIf(process.platform === "win32")("Hermes local credential config transaction", () => {
  let fixture: ReturnType<typeof createRestartFixture>;
  let config: Record<string, unknown>;

  beforeEach(() => {
    fixture = createRestartFixture();
    config = {};
    applyHermesManagedRoute(config, { ...route, nativeCredentialHandle: issued("v9") });
  });

  afterEach(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  it.each(["v7", "v8", `s${"a".repeat(64)}`])(
    "replaces the prior reference with %s without a provider environment and preserves unrelated state",
    (scope) => {
      const mcp = { example: { command: "example-mcp" } };
      const unrelated = { name: "user-provider", api_key: "${USER_KEY}" };
      const prior: Record<string, unknown> = {
        model: { default: "old-model" },
        providers: { user: unrelated },
        custom_providers: [unrelated],
        mcp_servers: mcp,
      };
      applyHermesManagedRoute(prior, { ...route, nativeCredentialHandle: issued("v6") });
      fixture.trustedConfig = yaml.dump(prior);
      fs.writeFileSync(fixture.configPath, fixture.trustedConfig);
      const hashes = hashInputs(fixture.configPath, fixture.envPath).replaceAll(
        digest("{}"),
        digest(JSON.stringify(mcp)),
      );
      fs.writeFileSync(fixture.hashPath, hashes);
      fs.writeFileSync(fixture.compatHashPath, hashes);

      applyHermesManagedRoute(prior, {
        ...route,
        model: `model-${scope}`,
        nativeCredentialHandle: issued(scope),
      });
      const result = runWriteConfig(fixture, digest(fixture.trustedConfig), yaml.dump(prior), {
        env: { PATH: process.env.PATH },
      });
      expect(result.status, result.stderr).toBe(0);
      const written = fs.readFileSync(fixture.configPath, "utf8");
      expect(yaml.load(written)).toEqual(prior);
      expect(written).not.toContain(issued("v6"));
      expect(prior.model.api_key).toBe(issued(scope));
      expect(prior.providers[route.upstreamProvider].api_key).toBe(issued(scope));
      expect(prior.custom_providers[1].api_key).toBe(issued(scope));
      expect(prior.providers.user).toEqual(unrelated);
      expect(prior.mcp_servers).toEqual(mcp);
      expect(fs.readFileSync(fixture.envPath, "utf8")).toBe(fixture.trustedEnv);
      expect(strictHashIsValid(fixture)).toBe(true);
      expect(fs.readFileSync(fixture.hashPath, "utf8")).toBe(
        fs.readFileSync(fixture.compatHashPath, "utf8"),
      );
      expect(mode(fixture.configPath)).toBe(0o640);
      expect(mode(fixture.envPath)).toBe(0o600);
      expect(fs.existsSync(fixture.statePath)).toBe(false);
      expect(fs.existsSync(path.join(fixture.root, "hermes-config-mutation.lock"))).toBe(false);
      expect(result.stdout + result.stderr).not.toContain(issued(scope));
    },
  );

  function expectRejectedWrite(expectedDigest: string, diagnostic: string): void {
    const originalHash = fs.readFileSync(fixture.hashPath, "utf8");
    const result = runWriteConfig(fixture, expectedDigest, yaml.dump(config), {
      env: { PATH: process.env.PATH },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(diagnostic);
    expect(fs.readFileSync(fixture.configPath, "utf8")).toBe(fixture.trustedConfig);
    expect(fs.readFileSync(fixture.envPath, "utf8")).toBe(fixture.trustedEnv);
    expect(fs.readFileSync(fixture.hashPath, "utf8")).toBe(originalHash);
    expect(fs.existsSync(fixture.statePath)).toBe(false);
    expect(fs.existsSync(path.join(fixture.root, "hermes-config-mutation.lock"))).toBe(false);
    expect(result.stdout + result.stderr).not.toContain(issued("v9"));
  }

  it("preserves trusted state when the host read is stale", () => {
    expectRejectedWrite(digest("stale config"), "config changed after the host read");
  });

  it("preserves trusted state when the schema rejects the candidate", () => {
    config.platforms = { teams: { home_channel: { id: "invalid" } } };
    expectRejectedWrite(digest(fixture.trustedConfig), "schema validation rejected");
  });

  it("preserves trusted state when the candidate changes MCP servers", () => {
    config.mcp_servers = { injected: { command: "untrusted" } };
    expectRejectedWrite(digest(fixture.trustedConfig), "cannot change Hermes mcp_servers");
  });

  it("preserves trusted state when the config path is a symlink", () => {
    const original = path.join(fixture.hermesDir, "original.yaml");
    fs.renameSync(fixture.configPath, original);
    fs.symlinkSync(original, fixture.configPath);
    expectRejectedWrite(
      digest(fixture.trustedConfig),
      "refusing unsafe Hermes runtime config path",
    );
  });
});

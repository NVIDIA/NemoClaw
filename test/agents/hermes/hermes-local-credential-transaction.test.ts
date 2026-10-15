// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";
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
  it("commits all three issued references without a provider environment and preserves unrelated state", () => {
    const fixture = createRestartFixture();
    try {
      const mcp = { example: { command: "example-mcp" } };
      const unrelated = { name: "user-provider", api_key: "${USER_KEY}" };
      const config: Record<string, unknown> = {
        model: { default: "old-model" },
        providers: { user: unrelated },
        custom_providers: [unrelated],
        mcp_servers: mcp,
      };
      fixture.trustedConfig = yaml.dump(config);
      fs.writeFileSync(fixture.configPath, fixture.trustedConfig);
      const hashes = hashInputs(fixture.configPath, fixture.envPath).replaceAll(
        digest("{}"),
        digest(JSON.stringify(mcp)),
      );
      fs.writeFileSync(fixture.hashPath, hashes);
      fs.writeFileSync(fixture.compatHashPath, hashes);

      for (const scope of ["v7", "v8", `s${"a".repeat(64)}`]) {
        const before = fs.readFileSync(fixture.configPath, "utf8");
        applyHermesManagedRoute(config, {
          ...route,
          model: `model-${scope}`,
          nativeCredentialHandle: issued(scope),
        });
        const result = runWriteConfig(fixture, digest(before), yaml.dump(config), {
          env: { PATH: process.env.PATH },
        });
        expect(result.status, result.stderr).toBe(0);
        expect(yaml.load(fs.readFileSync(fixture.configPath, "utf8"))).toEqual(config);
        expect(config.model.api_key).toBe(issued(scope));
        expect(config.providers[route.upstreamProvider].api_key).toBe(issued(scope));
        expect(config.custom_providers[1].api_key).toBe(issued(scope));
        expect(config.providers.user).toEqual(unrelated);
        expect(config.mcp_servers).toEqual(mcp);
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
      }
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it.each(["stale-read", "schema", "mcp-change", "symlink"])(
    "preserves the trusted config and environment when a local credential write fails at %s",
    (failure) => {
      const fixture = createRestartFixture();
      try {
        const config: Record<string, unknown> = {};
        applyHermesManagedRoute(config, { ...route, nativeCredentialHandle: issued("v9") });
        if (failure === "schema") config.platforms = { teams: { home_channel: { id: "invalid" } } };
        if (failure === "mcp-change") config.mcp_servers = { injected: { command: "untrusted" } };
        const originalHash = fs.readFileSync(fixture.hashPath, "utf8");
        if (failure === "symlink") {
          const original = path.join(fixture.hermesDir, "original.yaml");
          fs.renameSync(fixture.configPath, original);
          fs.symlinkSync(original, fixture.configPath);
        }
        const result = runWriteConfig(
          fixture,
          digest(failure === "stale-read" ? "stale config" : fixture.trustedConfig),
          yaml.dump(config),
          { env: { PATH: process.env.PATH } },
        );
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          {
            "stale-read": "config changed after the host read",
            schema: "schema validation rejected",
            "mcp-change": "cannot change Hermes mcp_servers",
            symlink: "refusing unsafe Hermes runtime config path",
          }[failure],
        );
        expect(fs.readFileSync(fixture.configPath, "utf8")).toBe(fixture.trustedConfig);
        expect(fs.readFileSync(fixture.envPath, "utf8")).toBe(fixture.trustedEnv);
        expect(fs.readFileSync(fixture.hashPath, "utf8")).toBe(originalHash);
        expect(fs.existsSync(fixture.statePath)).toBe(false);
        expect(fs.existsSync(path.join(fixture.root, "hermes-config-mutation.lock"))).toBe(false);
        expect(result.stdout + result.stderr).not.toContain(issued("v9"));
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    },
  );
});

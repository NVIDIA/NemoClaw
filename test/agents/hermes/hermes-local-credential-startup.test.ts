// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import yaml from "js-yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyHermesManagedRoute,
  type HermesManagedRouting,
} from "../../../src/lib/hermes-managed-route";
import {
  createRestartFixture,
  gatewayConfigStubRoot,
  hashInputs,
  mode,
  RUNTIME_CONFIG_GUARD,
  strictHashIsValid,
} from "../../helpers/hermes-restart-config-seal-fixture";

const issued = (scope: string) => `openshell:resolve:env:${scope}_NEMOCLAW_LOCAL_INFERENCE_TOKEN`;
const route = {
  upstreamProvider: "vllm-local",
  baseUrl: "http://host.openshell.internal:8000/v1",
  inferenceApi: "openai-completions",
  model: "selected-model",
};

describe.skipIf(process.platform === "win32")("Hermes native local startup refresh", () => {
  let fixture: ReturnType<typeof createRestartFixture>;
  let config: Record<string, unknown> & HermesManagedRouting;
  beforeEach(() => {
    fixture = createRestartFixture();
    const initial: Record<string, unknown> = {
      providers: { user: { api_key: "${USER_KEY}" } },
      custom_providers: [{ name: "user", api_key: "${USER_KEY}" }],
      mcp_servers: { example: { command: "example-mcp" } },
    };
    applyHermesManagedRoute(initial, route);
    config = initial;
  });
  afterEach(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  function persistConfig(): void {
    fs.writeFileSync(fixture.configPath, yaml.dump(config));
    const hashes = hashInputs(fixture.configPath, fixture.envPath);
    fs.writeFileSync(fixture.hashPath, hashes);
    fs.writeFileSync(fixture.compatHashPath, hashes);
  }

  function readConfigSnapshot() {
    const fd = fs.openSync(fixture.configPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      return { contents: fs.readFileSync(fd, "utf8"), inode: fs.fstatSync(fd).ino };
    } finally {
      fs.closeSync(fd);
    }
  }

  function refresh(reference: string, args: string[] = ["--refresh-native-local"]) {
    return spawnSync(
      "python3",
      [
        "-I",
        "-c",
        "import runpy, sys; source = sys.argv.pop(1); sys.path.insert(0, sys.argv.pop(1)); sys.argv[0] = source; runpy.run_path(source, run_name='__main__')",
        RUNTIME_CONFIG_GUARD,
        gatewayConfigStubRoot(fixture.root),
        "provider-placeholders",
        "--hermes-dir",
        fixture.hermesDir,
        "--hash-file",
        fixture.hashPath,
        "--mode",
        "both",
        ...args,
      ],
      {
        encoding: "utf8",
        timeout: 10_000,
        env: { PATH: process.env.PATH, NEMOCLAW_LOCAL_INFERENCE_TOKEN: reference },
      },
    );
  }

  it.each(["v7", "v8", `s${"a".repeat(64)}`])(
    "materializes %s at fresh startup with schema and integrity validation",
    (scope) => {
      persistConfig();
      const priorInode = readConfigSnapshot().inode;
      const result = refresh(issued(scope));
      expect(result.status, result.stderr).toBe(0);
      applyHermesManagedRoute(config, { ...route, nativeCredentialHandle: issued(scope) });
      const written = readConfigSnapshot();
      expect(yaml.load(written.contents)).toEqual(config);
      expect(written.inode).not.toBe(priorInode);
      expect(mode(fixture.configPath)).toBe(0o640);
      expect(mode(fixture.envPath)).toBe(0o600);
      expect(fs.readFileSync(fixture.envPath, "utf8")).toBe(fixture.trustedEnv);
      expect(strictHashIsValid(fixture)).toBe(true);
      expect(fs.readFileSync(fixture.hashPath, "utf8")).toBe(
        fs.readFileSync(fixture.compatHashPath, "utf8"),
      );
      expect(result.stdout + result.stderr).not.toContain(issued(scope));
    },
  );

  it("rotates a persisted reference when OpenShell launches a fresh entrypoint", () => {
    applyHermesManagedRoute(config, { ...route, nativeCredentialHandle: issued("v7") });
    persistConfig();
    const result = refresh(issued("v8"));
    expect(result.status, result.stderr).toBe(0);
    applyHermesManagedRoute(config, { ...route, nativeCredentialHandle: issued("v8") });
    expect(yaml.load(fs.readFileSync(fixture.configPath, "utf8"))).toEqual(config);
    expect(strictHashIsValid(fixture)).toBe(true);
  });

  it("preserves unrelated mappings that alias managed YAML objects", () => {
    config.providers.user = config.providers[route.upstreamProvider];
    config.mcp_servers = { example: config.model };
    persistConfig();
    const originalUnrelated = structuredClone(config.providers.user);
    const originalMcp = structuredClone(config.mcp_servers);
    const result = refresh(issued("v8"));
    expect(result.status, result.stderr).toBe(0);
    const written = yaml.load(fs.readFileSync(fixture.configPath, "utf8")) as typeof config;
    expect(written.model.api_key).toBe(issued("v8"));
    expect(written.providers.user).toEqual(originalUnrelated);
    expect(written.mcp_servers).toEqual(originalMcp);
    expect(strictHashIsValid(fixture)).toBe(true);
  });

  it("preserves the host-written newer reference on an internal gateway restart", () => {
    applyHermesManagedRoute(config, { ...route, nativeCredentialHandle: issued("v8") });
    persistConfig();
    const original = readConfigSnapshot();
    const result = refresh(issued("v7"), []);
    expect(result.status, result.stderr).toBe(0);
    const written = readConfigSnapshot();
    expect(written.contents).toBe(original.contents);
    expect(written.inode).toBe(original.inode);
    expect(strictHashIsValid(fixture)).toBe(true);
  });

  it.each([
    "",
    "synthetic-raw-secret",
    "openshell:resolve:env:NEMOCLAW_LOCAL_INFERENCE_TOKEN",
    "openshell:resolve:env:v8_OPENAI_API_KEY",
    `${issued("v8")}\n`,
  ])("rejects invalid runtime input case %# without modifying files or logging it", (reference) => {
    persistConfig();
    const original = fs.readFileSync(fixture.configPath, "utf8");
    const hashes = fs.readFileSync(fixture.hashPath, "utf8");
    const result = refresh(reference);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("requires a provider-bound credential handle");
    expect(fs.readFileSync(fixture.configPath, "utf8")).toBe(original);
    expect(fs.readFileSync(fixture.hashPath, "utf8")).toBe(hashes);
    expect(fs.readFileSync(fixture.envPath, "utf8")).toBe(fixture.trustedEnv);
    expect(result.stdout + result.stderr).not.toContain("synthetic-raw-secret");
    expect(result.stdout + result.stderr).not.toContain("openshell:resolve:env:");
  });

  it("rejects inconsistent managed slots before writing", () => {
    config.custom_providers[1].api_key = issued("v1");
    persistConfig();
    const original = fs.readFileSync(fixture.configPath, "utf8");
    const result = refresh(issued("v8"));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("managed credential slots are inconsistent");
    expect(fs.readFileSync(fixture.configPath, "utf8")).toBe(original);
  });

  it("rejects invalid Hermes schema before writing", () => {
    config.platforms = { teams: { home_channel: { id: "invalid" } } };
    persistConfig();
    const original = fs.readFileSync(fixture.configPath, "utf8");
    const result = refresh(issued("v8"));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("schema validation rejected");
    expect(fs.readFileSync(fixture.configPath, "utf8")).toBe(original);
  });

  it("refuses a symlinked config without changing its target or hashes", () => {
    persistConfig();
    const original = fs.readFileSync(fixture.configPath, "utf8");
    const hashes = fs.readFileSync(fixture.hashPath, "utf8");
    const target = `${fixture.configPath}.target`;
    fs.renameSync(fixture.configPath, target);
    fs.symlinkSync(target, fixture.configPath);
    const result = refresh(issued("v8"));
    expect(result.status).not.toBe(0);
    expect(fs.lstatSync(fixture.configPath).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe(original);
    expect(fs.readFileSync(fixture.hashPath, "utf8")).toBe(hashes);
    expect(result.stdout + result.stderr).not.toContain(issued("v8"));
  });

  it("leaves shared routing unchanged without a local credential", () => {
    applyHermesManagedRoute(config, { ...route, baseUrl: "https://inference.local/v1" });
    persistConfig();
    const original = fs.readFileSync(fixture.configPath, "utf8");
    const result = refresh("");
    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(fixture.configPath, "utf8")).toBe(original);
  });
});

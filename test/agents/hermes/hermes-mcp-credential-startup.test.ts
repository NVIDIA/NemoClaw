// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyHermesManagedRoute } from "../../../src/lib/hermes-managed-route";
import {
  createRestartFixture,
  gatewayConfigStubRoot,
  hashInputs,
  mode,
  RUNTIME_CONFIG_GUARD,
  strictHashIsValid,
} from "../../helpers/hermes-restart-config-seal-fixture";

type McpServer = Record<string, unknown> & { headers?: Record<string, string> };
type HermesConfig = Record<string, unknown> & { mcp_servers: Record<string, McpServer> };

const handle = (scope: string, envKey = "QMD_MCP_TOKEN") =>
  `openshell:resolve:env:${scope}_${envKey}`;
const bearer = (scope: string, envKey?: string) => `Bearer ${handle(scope, envKey)}`;
const stable = `s${"a".repeat(64)}`;
const localHandle = (scope: string) => handle(scope, "NEMOCLAW_LOCAL_INFERENCE_TOKEN");
const localRoute = {
  upstreamProvider: "vllm-local",
  baseUrl: "http://host.openshell.internal:8000/v1",
  inferenceApi: "openai-completions",
  model: "selected-model",
};

function managedServer(scope: string, envKey?: string): McpServer {
  return {
    url: "https://mcp.example.test/mcp",
    enabled: true,
    timeout: 120,
    connect_timeout: 60,
    tools: { resources: true, prompts: true },
    headers: { Authorization: bearer(scope, envKey) },
  };
}

describe.skipIf(process.platform === "win32")("Hermes MCP credential startup refresh", () => {
  let fixture: ReturnType<typeof createRestartFixture>;
  let config: HermesConfig;

  beforeEach(() => {
    fixture = createRestartFixture();
    config = {
      model: { default: "trusted-model" },
      mcp_servers: {
        qmd: managedServer("v5"),
        local: { command: "example-mcp" },
        custom: {
          url: "https://other.example.test/mcp",
          headers: { Authorization: bearer("v5"), "X-Extra": "1" },
        },
        user: { url: "https://user.example.test/mcp", headers: { Authorization: bearer("v5") } },
        plain: {
          url: "https://plain.example.test/mcp",
          enabled: true,
          timeout: 120,
          connect_timeout: 60,
          tools: { resources: true, prompts: true },
        },
      },
    };
  });
  afterEach(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  function persistConfig(): void {
    fs.writeFileSync(fixture.configPath, yaml.dump(config));
    const hashes = hashInputs(fixture.configPath, fixture.envPath);
    fs.writeFileSync(fixture.hashPath, hashes);
    fs.writeFileSync(fixture.compatHashPath, hashes);
  }

  function readConfig(): HermesConfig {
    return yaml.load(fs.readFileSync(fixture.configPath, "utf8")) as HermesConfig;
  }

  function readConfigSnapshot() {
    const fd = fs.openSync(fixture.configPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      return { contents: fs.readFileSync(fd, "utf8"), inode: fs.fstatSync(fd).ino };
    } finally {
      fs.closeSync(fd);
    }
  }

  function refresh(env: Record<string, string>, args: string[] = ["--refresh-native-local"]) {
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
      { encoding: "utf8", timeout: 10_000, env: { PATH: process.env.PATH, ...env } },
    );
  }

  function managedGuard(script: string, env: Record<string, string>, candidate = "") {
    const wrapper = String.raw`
import contextlib, hashlib, importlib.util, io, os, sys
source, python_root, home, strict, state = sys.argv[1:]
sys.path.insert(0, python_root)
spec = importlib.util.spec_from_file_location("hermes_mcp_startup_fixture", source)
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
module._managed_nonroot_reconciliation_is_allowed = lambda: True
module._sandbox_identity = lambda: (os.geteuid(), os.getegid())
`;
    return spawnSync(
      "python3",
      [
        "-I",
        "-c",
        wrapper + script,
        RUNTIME_CONFIG_GUARD,
        gatewayConfigStubRoot(fixture.root),
        fixture.hermesDir,
        fixture.hashPath,
        fixture.statePath,
      ],
      {
        encoding: "utf8",
        input: candidate,
        timeout: 10_000,
        env: { PATH: process.env.PATH, ...env },
      },
    );
  }

  function compatStartup(env: Record<string, string>) {
    const result = managedGuard(
      `with contextlib.redirect_stdout(io.StringIO()):
    module.ensure_api_key(home, strict, "compat")
    module.provider_placeholders(home, strict, "compat", None, None, True)
    module.refresh_hashes(home, strict, "compat")
`,
      env,
    );
    expect(result.status, result.stderr).toBe(0);
  }

  function managedWrite(candidate: string, env: Record<string, string> = {}) {
    return managedGuard(
      `with open(os.path.join(home, "config.yaml"), "rb") as stream:
    expected = hashlib.sha256(stream.read()).hexdigest()
module.write_config_transaction(home, strict, state, expected, sys.stdin.buffer.read())
`,
      env,
      candidate,
    );
  }

  function prepareMutableConfig(): void {
    persistConfig();
    fs.chmodSync(fixture.hermesDir, 0o700);
  }

  function protectedInputs(): Buffer[] {
    return [fixture.configPath, fixture.envPath, fixture.compatHashPath, fixture.hashPath].map(
      (pathname) => fs.readFileSync(pathname),
    );
  }

  it("recognizes the managed entry that the MCP transaction builds through the guard", () => {
    const script = String.raw`
import importlib.util, sys
def load(name, source):
    spec = importlib.util.spec_from_file_location(name, source)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module
guard = load("hermes_guard_owner", sys.argv[1])
transaction = load("hermes_transaction_owner", sys.argv[2])
transaction.GUARD_PATH = sys.argv[1]
entry = {"url": "https://mcp.example.test/mcp", "headers": {"Authorization": sys.argv[3]}}
candidate = transaction._managed_candidate(entry)
assert candidate == guard.managed_mcp_entry(entry["url"], entry["headers"]), sorted(candidate)
assert guard._mcp_authorization_handle(candidate) == ("QMD_MCP_TOKEN", sys.argv[3][len("Bearer "):])
changed = [{**candidate, "enabled": False}, {**candidate, "timeout": 30}, {**candidate, "connect_timeout": 1}, {**candidate, "tools": {"resources": False, "prompts": True}}, {**candidate, "extra": True}, entry, guard.managed_mcp_entry(entry["url"], {})]
assert [guard._mcp_authorization_handle(value) for value in changed] == [None] * len(changed)
print("owner-ok")
`;
    const result = spawnSync(
      "python3",
      [
        "-I",
        "-c",
        script,
        RUNTIME_CONFIG_GUARD,
        path.join(path.dirname(RUNTIME_CONFIG_GUARD), "mcp-config-transaction.py"),
        bearer("v5"),
      ],
      { encoding: "utf8", timeout: 10_000 },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("owner-ok");
  });

  it.each(["v6", stable])(
    "rebinds a stale managed MCP header to %s and keeps user entries",
    (scope) => {
      persistConfig();
      const result = refresh({ QMD_MCP_TOKEN: handle(scope) });

      expect(result.status, result.stderr).toBe(0);
      expect(readConfig()).toEqual({
        ...config,
        mcp_servers: { ...config.mcp_servers, qmd: managedServer(scope) },
      });
      expect(strictHashIsValid(fixture)).toBe(true);
      expect(fs.readFileSync(fixture.hashPath, "utf8")).toBe(
        fs.readFileSync(fixture.compatHashPath, "utf8"),
      );
      expect(result.stderr).toContain(
        "Refreshed Hermes MCP credential reference for QMD_MCP_TOKEN",
      );
      expect(result.stdout + result.stderr).not.toContain(handle(scope));
    },
  );

  it("copies an aliased managed MCP mapping instead of mutating its other users", () => {
    const shared = managedServer("v5");
    config.mcp_servers = { qmd: shared, mirror: shared };
    config.unrelated = { server: shared };
    persistConfig();

    const result = refresh({ QMD_MCP_TOKEN: handle("v6") });

    expect(result.status, result.stderr).toBe(0);
    const written = readConfig();
    expect(written.mcp_servers.qmd).toEqual(managedServer("v6"));
    expect(written.mcp_servers.mirror).toEqual(managedServer("v6"));
    expect(written.unrelated).toEqual({ server: managedServer("v5") });
  });

  it.each<{ name: string; env: Record<string, string>; args?: string[] }>([
    { name: "internal gateway relaunch", env: { QMD_MCP_TOKEN: handle("v6") }, args: [] },
    { name: "missing runtime handle", env: {} },
    { name: "current handle", env: { QMD_MCP_TOKEN: handle("v5") } },
    { name: "handle for another key", env: { QMD_MCP_TOKEN: handle("v6", "OTHER_TOKEN") } },
    { name: "raw secret", env: { QMD_MCP_TOKEN: "synthetic-raw-secret" } },
    { name: "unscoped handle", env: { QMD_MCP_TOKEN: "openshell:resolve:env:QMD_MCP_TOKEN" } },
    { name: "trailing newline", env: { QMD_MCP_TOKEN: `${handle("v6")}\n` } },
  ])("leaves MCP headers unchanged for $name", ({ env, args }) => {
    persistConfig();
    const original = readConfigSnapshot();

    const result = refresh(env, args);

    expect(result.status, result.stderr).toBe(0);
    expect(readConfigSnapshot()).toEqual(original);
    expect(strictHashIsValid(fixture)).toBe(true);
    expect(result.stdout + result.stderr).not.toContain("synthetic-raw-secret");
  });

  it("allows an ordinary host config write after a non-root MCP header refresh", () => {
    prepareMutableConfig();
    compatStartup({ QMD_MCP_TOKEN: handle("v6") });
    const refreshed = readConfig();
    expect(refreshed.mcp_servers.qmd).toEqual(managedServer("v6"));
    expect(fs.existsSync(`${fixture.hermesDir}/.native-local-startup-config`)).toBe(true);
    const candidate = { ...refreshed, temperature: 0.2 };

    const result = managedWrite(yaml.dump(candidate));

    expect(result.status, result.stderr).toBe(0);
    expect(readConfig()).toEqual(candidate);
    expect(strictHashIsValid(fixture)).toBe(true);
    expect(fs.readFileSync(fixture.hashPath, "utf8")).toBe(
      fs.readFileSync(fixture.compatHashPath, "utf8"),
    );
    expect(fs.existsSync(`${fixture.hermesDir}/.native-local-startup-config`)).toBe(false);
    expect(fs.existsSync(fixture.statePath)).toBe(false);
    expect(result.stdout + result.stderr).not.toContain(handle("v6"));
  });

  it("keeps distinct same-key MCP handles when replaying a native local refresh", () => {
    applyHermesManagedRoute(config, localRoute);
    config.mcp_servers = {
      qmd: managedServer("v5"),
      mirror: { ...managedServer("v6"), url: "https://mirror.example.test/mcp" },
    };
    prepareMutableConfig();
    const env = { NEMOCLAW_LOCAL_INFERENCE_TOKEN: localHandle("v7") };
    compatStartup(env);
    const refreshed = readConfig();
    expect(refreshed.mcp_servers).toEqual(config.mcp_servers);
    expect(refreshed.model).toMatchObject({ api_key: localHandle("v7") });
    const candidate = { ...refreshed, temperature: 0.2 };

    const result = managedWrite(yaml.dump(candidate), env);

    expect(result.status, result.stderr).toBe(0);
    expect(readConfig()).toEqual(candidate);
    expect(strictHashIsValid(fixture)).toBe(true);
  });

  it("replays a combined native local and MCP startup refresh during a host config write", () => {
    applyHermesManagedRoute(config, localRoute);
    prepareMutableConfig();
    const env = { QMD_MCP_TOKEN: handle("v6"), NEMOCLAW_LOCAL_INFERENCE_TOKEN: localHandle("v7") };
    compatStartup(env);
    const refreshed = readConfig();
    expect(refreshed.mcp_servers.qmd).toEqual(managedServer("v6"));
    expect(refreshed.model).toMatchObject({ api_key: localHandle("v7") });
    expect(fs.existsSync(`${fixture.hermesDir}/.native-local-startup-config`)).toBe(true);
    const candidate = { ...refreshed, temperature: 0.2 };

    const result = managedWrite(yaml.dump(candidate), env);

    expect(result.status, result.stderr).toBe(0);
    expect(readConfig()).toEqual(candidate);
    expect(strictHashIsValid(fixture)).toBe(true);
    expect(fs.existsSync(`${fixture.hermesDir}/.native-local-startup-config`)).toBe(false);
    expect(result.stdout + result.stderr).not.toContain(handle("v6"));
    expect(result.stdout + result.stderr).not.toContain(localHandle("v7"));
  });

  it.each([
    {
      name: "header rebound to another credential key",
      mutate: (current: HermesConfig) => {
        current.mcp_servers.qmd = managedServer("v6", "OTHER_TOKEN");
      },
    },
    {
      name: "extra header on the refreshed server",
      mutate: (current: HermesConfig) => {
        current.mcp_servers.qmd.headers = { Authorization: bearer("v6"), "X-Extra": "1" };
      },
    },
    {
      name: "changed MCP endpoint",
      mutate: (current: HermesConfig) => {
        current.mcp_servers.qmd.url = "https://attacker.example.test/mcp";
      },
    },
    {
      name: "unrelated user header rebound",
      mutate: (current: HermesConfig) => {
        current.mcp_servers.custom.headers = { Authorization: bearer("v6"), "X-Extra": "1" };
      },
    },
    {
      name: "user-owned bearer-only header rebound",
      mutate: (current: HermesConfig) => {
        current.mcp_servers.user.headers = { Authorization: bearer("v6") };
      },
    },
  ])("refuses a host config write after non-root startup with $name", ({ mutate }) => {
    prepareMutableConfig();
    compatStartup({ QMD_MCP_TOKEN: handle("v6") });
    const tampered = readConfig();
    mutate(tampered);
    fs.writeFileSync(fixture.configPath, yaml.dump(tampered));
    fs.writeFileSync(fixture.compatHashPath, hashInputs(fixture.configPath, fixture.envPath));
    const before = protectedInputs();
    const originalDirectoryMode = mode(fixture.hermesDir);

    const result = managedWrite(yaml.dump({ ...tampered, temperature: 0.2 }));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "refusing config drift during non-root strict hash reconciliation",
    );
    expect(protectedInputs()).toEqual(before);
    expect(mode(fixture.hermesDir)).toBe(originalDirectoryMode);
    expect(fs.existsSync(fixture.statePath)).toBe(false);
  });
});

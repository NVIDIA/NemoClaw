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

  function managedGuard(script: string, candidate = "", reference = issued("v7")) {
    const wrapper = String.raw`
import contextlib, hashlib, importlib.util, io, os, sys
source, python_root, home, strict, state = sys.argv[1:]
sys.path.insert(0, python_root)
spec = importlib.util.spec_from_file_location("hermes_startup_write_fixture", source)
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
        env: { PATH: process.env.PATH, NEMOCLAW_LOCAL_INFERENCE_TOKEN: reference },
      },
    );
  }

  function compatStartup(reference = issued("v7")) {
    return managedGuard(
      `with contextlib.redirect_stdout(io.StringIO()):
    module.ensure_api_key(home, strict, "compat")
    module.provider_placeholders(home, strict, "compat", None, None, True)
    module.refresh_hashes(home, strict, "compat")
`,
      "",
      reference,
    );
  }

  function managedWrite(candidate: string, injection = "") {
    return managedGuard(
      injection +
        `with open(os.path.join(home, "config.yaml"), "rb") as stream:
    expected = hashlib.sha256(stream.read()).hexdigest()
module.write_config_transaction(home, strict, state, expected, sys.stdin.buffer.read())
`,
      candidate,
    );
  }

  function expectCompatStartup(reference = issued("v7")): void {
    const result = compatStartup(reference);
    expect(result.status, result.stderr).toBe(0);
  }

  function prepareMutableConfig(): void {
    persistConfig();
    fs.chmodSync(fixture.hermesDir, 0o700);
  }

  const startupWitness = () => `${fixture.hermesDir}/.native-local-startup-config`;

  function changedModelCandidate(reference = issued("v7")): string {
    applyHermesManagedRoute(config, {
      ...route,
      model: "changed-model",
      nativeCredentialHandle: reference,
    });
    return yaml.dump(config);
  }

  it.each([
    {
      name: "initial template",
      prepare: () => prepareMutableConfig(),
      start: () => expectCompatStartup(),
      reference: issued("v7"),
    },
    {
      name: "previous issued reference",
      prepare: () => {
        applyHermesManagedRoute(config, { ...route, nativeCredentialHandle: issued("v6") });
        prepareMutableConfig();
      },
      start: () => expectCompatStartup(),
      reference: issued("v7"),
    },
    {
      name: "repeated fresh entrypoints before the first host write",
      prepare: () => prepareMutableConfig(),
      start: () => {
        expectCompatStartup();
        const originalWitness = fs.readFileSync(startupWitness());
        expectCompatStartup(issued(`s${"a".repeat(64)}`));
        expect(fs.readFileSync(startupWitness())).toEqual(originalWitness);
      },
      reference: issued(`s${"a".repeat(64)}`),
    },
    {
      name: "aliased unrelated mappings across two fresh rotations",
      prepare: () => {
        config.providers.user = config.providers[route.upstreamProvider];
        config.mcp_servers = { example: config.model };
        prepareMutableConfig();
      },
      start: () => {
        expectCompatStartup();
        expectCompatStartup(issued("v8"));
      },
      reference: issued("v8"),
    },
    {
      name: "existing API bearer key",
      prepare: () => {
        fs.appendFileSync(fixture.envPath, `API_SERVER_KEY=${"a".repeat(64)}\n`);
        prepareMutableConfig();
      },
      start: () => expectCompatStartup(),
      reference: issued("v7"),
    },
    {
      name: "fresh entrypoint after a completed host write",
      prepare: () => prepareMutableConfig(),
      start: () => {
        expectCompatStartup();
        const first = managedWrite(changedModelCandidate());
        expect(first.status, first.stderr).toBe(0);
        const trustedConfig = fs.readFileSync(fixture.configPath);
        expectCompatStartup(issued("v8"));
        expect(fs.readFileSync(startupWitness())).toEqual(trustedConfig);
      },
      reference: issued("v8"),
    },
  ])(
    "allows an ordinary model write after compat startup: $name",
    ({ prepare, start, reference }) => {
      prepare();
      start();
      const startupEnv = fs.readFileSync(fixture.envPath);

      const result = managedWrite(changedModelCandidate(reference));

      expect(result.status, result.stderr).toBe(0);
      expect(yaml.load(fs.readFileSync(fixture.configPath, "utf8"))).toEqual(config);
      expect(fs.readFileSync(fixture.envPath)).toEqual(startupEnv);
      expect(strictHashIsValid(fixture)).toBe(true);
      expect(fs.readFileSync(fixture.hashPath, "utf8")).toBe(
        fs.readFileSync(fixture.compatHashPath, "utf8"),
      );
      expect(fs.existsSync(fixture.statePath)).toBe(false);
      expect(fs.existsSync(`${fixture.root}/hermes-config-mutation.lock`)).toBe(false);
      expect(result.stdout + result.stderr).not.toContain(reference);
      expect(fs.existsSync(startupWitness())).toBe(false);
    },
  );

  function protectedInputs(): Buffer[] {
    return [fixture.configPath, fixture.envPath, fixture.compatHashPath, fixture.hashPath].map(
      (pathname) => fs.readFileSync(pathname),
    );
  }

  it.each([
    {
      name: "unrelated config change with matching host and compatibility digests",
      mutate: () => fs.appendFileSync(fixture.configPath, "unrelated_setting: untrusted\n"),
    },
    {
      name: "unrelated env change with matching compatibility digest",
      mutate: () => fs.appendFileSync(fixture.envPath, "SAFE_SETTING=untrusted\n"),
    },
    {
      name: "missing witness",
      mutate: () => fs.unlinkSync(startupWitness()),
    },
    {
      name: "malformed witness",
      mutate: () => fs.writeFileSync(startupWitness(), "[\n"),
    },
    {
      name: "witness with a different strict digest",
      mutate: () => fs.appendFileSync(startupWitness(), "\n"),
    },
    {
      name: "symlinked witness",
      diagnostic: /OSError:.*Too many levels of symbolic links/,
      mutate: () => {
        fs.renameSync(startupWitness(), `${startupWitness()}.target`);
        fs.symlinkSync(`${startupWitness()}.target`, startupWitness());
      },
    },
    {
      name: "multiply linked witness",
      mutate: () => fs.linkSync(startupWitness(), `${startupWitness()}.alias`),
    },
  ])(
    "refuses ordinary model write after compat startup with $name",
    ({ mutate, diagnostic = /UnsafePathError|SECURITY/ }) => {
      prepareMutableConfig();
      expectCompatStartup();
      mutate();
      fs.writeFileSync(fixture.compatHashPath, hashInputs(fixture.configPath, fixture.envPath));
      const before = protectedInputs();
      const originalDirectoryMode = mode(fixture.hermesDir);

      const result = managedWrite(changedModelCandidate());

      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(diagnostic);
      expect(protectedInputs()).toEqual(before);
      expect(mode(fixture.hermesDir)).toBe(originalDirectoryMode);
      expect(fs.existsSync(fixture.statePath)).toBe(false);
      expect(fs.existsSync(`${fixture.root}/hermes-config-mutation.lock`)).toBe(false);
      expect(result.stdout + result.stderr).not.toContain(issued("v7"));
    },
  );

  it("preserves mutable startup edits without granting them strict host-write authority", () => {
    fs.appendFileSync(fixture.envPath, `API_SERVER_KEY=${"a".repeat(64)}\n`);
    prepareMutableConfig();
    expectCompatStartup();
    const originalWitness = fs.readFileSync(startupWitness());
    config = yaml.load(fs.readFileSync(fixture.configPath, "utf8")) as typeof config;
    config.temperature = 0.2;
    config.mcp_servers = { example: { command: "example-mcp", args: ["--tuned"] } };
    fs.writeFileSync(fixture.configPath, yaml.dump(config));
    fs.writeFileSync(fixture.compatHashPath, hashInputs(fixture.configPath, fixture.envPath));

    expectCompatStartup(issued("v8"));

    const refreshed = yaml.load(fs.readFileSync(fixture.configPath, "utf8")) as typeof config;
    expect(refreshed.temperature).toBe(0.2);
    expect(refreshed.mcp_servers).toEqual(config.mcp_servers);
    expect(refreshed.model.api_key).toBe(issued("v8"));
    expect(refreshed.providers[route.upstreamProvider].api_key).toBe(issued("v8"));
    expect(
      refreshed.custom_providers.find((provider) => provider.name === route.upstreamProvider)
        ?.api_key,
    ).toBe(issued("v8"));
    expect(fs.readFileSync(startupWitness())).toEqual(originalWitness);
    const before = protectedInputs();
    const originalDirectoryMode = mode(fixture.hermesDir);
    const result = managedWrite(changedModelCandidate(issued("v8")));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "refusing config drift during non-root strict hash reconciliation",
    );
    expect(protectedInputs()).toEqual(before);
    expect(mode(fixture.hermesDir)).toBe(originalDirectoryMode);
    expect(fs.existsSync(fixture.statePath)).toBe(false);
    expect(fs.existsSync(`${fixture.root}/hermes-config-mutation.lock`)).toBe(false);
  });

  it("refuses a startup witness changed after proof and before strict commit", () => {
    prepareMutableConfig();
    expectCompatStartup();
    const before = protectedInputs();
    const originalDirectoryMode = mode(fixture.hermesDir);
    const result = managedWrite(
      changedModelCandidate(),
      `original_prove = module._prove_native_local_startup_config
def race_witness(path, *args):
    proof = original_prove(path, *args)
    with open(path, "ab") as retained:
        retained.write(b"\\n")
    return proof
module._prove_native_local_startup_config = race_witness
`,
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "refusing raced Hermes inputs during strict hash reconciliation",
    );
    expect(protectedInputs()).toEqual(before);
    expect(mode(fixture.hermesDir)).toBe(originalDirectoryMode);
    expect(fs.existsSync(fixture.statePath)).toBe(false);
    expect(fs.existsSync(`${fixture.root}/hermes-config-mutation.lock`)).toBe(false);
  });

  it("retains the original strict anchor when startup reconciliation cannot commit", () => {
    prepareMutableConfig();
    expectCompatStartup();
    const before = protectedInputs();
    const witness = fs.readFileSync(startupWitness());
    const result = managedWrite(
      changedModelCandidate(),
      `def reject_commit(path, text):
    raise RuntimeError("injected strict commit failure")
module._write_hash = reject_commit
`,
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("injected strict commit failure");
    expect(protectedInputs()).toEqual(before);
    expect(fs.readFileSync(startupWitness())).toEqual(witness);
    expect(fs.existsSync(fixture.statePath)).toBe(false);
    expect(fs.existsSync(`${fixture.root}/hermes-config-mutation.lock`)).toBe(false);
    const retry = managedWrite(changedModelCandidate());
    expect(retry.status, retry.stderr).toBe(0);
    expect(strictHashIsValid(fixture)).toBe(true);
  });

  it("keeps committed strict trust when stale startup witness cleanup fails", () => {
    prepareMutableConfig();
    expectCompatStartup();
    const result = managedWrite(
      changedModelCandidate(),
      `original_unlink = module.os.unlink
def reject_witness_cleanup(path, *args, **kwargs):
    if path == ".native-local-startup-config":
        raise PermissionError("injected witness cleanup failure")
    return original_unlink(path, *args, **kwargs)
module.os.unlink = reject_witness_cleanup
`,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain(
      "Retained stale native local startup witness after strict commit",
    );
    expect(yaml.load(fs.readFileSync(fixture.configPath, "utf8"))).toEqual(config);
    expect(strictHashIsValid(fixture)).toBe(true);
    expect(fs.existsSync(startupWitness())).toBe(true);
    expect(result.stdout + result.stderr).not.toContain(issued("v7"));
    const retry = managedWrite(changedModelCandidate());
    expect(retry.status, retry.stderr).toBe(0);
    expect(strictHashIsValid(fixture)).toBe(true);
    const currentBaseline = fs.readFileSync(fixture.configPath);
    expectCompatStartup(issued("v8"));
    expect(fs.readFileSync(startupWitness())).toEqual(currentBaseline);
    const rotated = managedWrite(changedModelCandidate(issued("v8")));
    expect(rotated.status, rotated.stderr).toBe(0);
    expect(strictHashIsValid(fixture)).toBe(true);
    expect(fs.existsSync(startupWitness())).toBe(false);
    expect(fs.existsSync(fixture.statePath)).toBe(false);
    expect(fs.existsSync(`${fixture.root}/hermes-config-mutation.lock`)).toBe(false);
  });

  it("rolls a failed model write back to the authenticated startup configuration", () => {
    prepareMutableConfig();
    expectCompatStartup();
    const startupConfig = fs.readFileSync(fixture.configPath);
    const startupEnv = fs.readFileSync(fixture.envPath);
    const result = managedWrite(
      changedModelCandidate(),
      `import json
original_replace = module._atomic_replace
fail_write = [True]
def reject_model_write(path, data, **kwargs):
    if path == os.path.join(home, "config.yaml") and os.path.exists(state) and json.load(open(state)).get("phase") == "config-write-prepared" and fail_write[0]:
        fail_write[0] = False
        raise RuntimeError("injected model write failure")
    return original_replace(path, data, **kwargs)
module._atomic_replace = reject_model_write
`,
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("injected model write failure");
    expect(fs.readFileSync(fixture.configPath)).toEqual(startupConfig);
    expect(fs.readFileSync(fixture.envPath)).toEqual(startupEnv);
    expect(strictHashIsValid(fixture)).toBe(true);
    expect(fs.readFileSync(fixture.hashPath)).toEqual(fs.readFileSync(fixture.compatHashPath));
    expect(fs.existsSync(fixture.statePath)).toBe(false);
    expect(fs.existsSync(`${fixture.root}/hermes-config-mutation.lock`)).toBe(false);
  });

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

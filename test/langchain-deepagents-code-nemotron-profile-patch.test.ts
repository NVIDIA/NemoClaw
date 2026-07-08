// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");
const agentDir = path.join(repoRoot, "agents", "langchain-deepagents-code");
const patcherPath = path.join(agentDir, "patch-nemotron-ultra-profile.py");
const validatorPath = path.join(agentDir, "validate-nemotron-ultra-profile.py");

const EXPECTED_DCODE_VERSION = "0.1.34";
const EXPECTED_DEEPAGENTS_VERSION = "0.7.0a6";
const NATIVE_PROFILE_SHA256 = "c8e8dd2b0182334b54be4f46ff0c7b45fbb95dc13bd9a92c249eb47a14fa13d7";
const PINNED_BUILTIN_SHA256 = "005a91e7fc4ca6b21220673dd9d02d6686bf63e1e4f1102d124b01f96886efcf";
const PATCHED_BUILTIN_SHA256 = "9d9e817143b330fd45345fcfa8276ea6fe5d6bc5a396f0438b0899a450e4744b";
const CANONICAL_MODEL_SPEC = "nvidia:nvidia/nemotron-3-ultra-550b-a55b";
const MANAGED_MODEL_ALIASES = [
  "openai:nvidia/nemotron-3-ultra-550b-a55b",
  "openai:nvidia/nvidia/nemotron-3-ultra",
] as const;

// This compact fixture preserves the exact 0.7.0a6 alias-patch anchors. The
// production constants above remain tied to the official wheel; private test
// patcher copies use fixture digests so drift cases stay focused and fast.
const BUILTIN_SOURCE = `"""Focused Deep Agents 0.7.0a6 bootstrap fixture."""

from deepagents.profiles.harness import (
    _anthropic_haiku_4_5,
    _anthropic_opus_4_7,
    _anthropic_sonnet_4_6,
    _nvidia_nemotron_3_ultra,
    _openai_codex,
)
from deepagents.profiles.harness.harness_profiles import _HARNESS_PROFILES
from deepagents.profiles.provider import _nvidia, _openai, _openrouter


def _invoke_profile_plugins(group: str) -> None:
    del group


def _ensure_builtin_profiles_loaded() -> None:
    try:
        _nvidia.register()
        _openai.register()
        _openrouter.register()
        _anthropic_opus_4_7.register()
        _anthropic_sonnet_4_6.register()
        _anthropic_haiku_4_5.register()
        _nvidia_nemotron_3_ultra.register()
        _openai_codex.register()
        _invoke_profile_plugins("deepagents.provider_profiles")
        _invoke_profile_plugins("deepagents.harness_profiles")
        frozenset(_HARNESS_PROFILES)
    except Exception:
        raise
`;

const NATIVE_PROFILE_SOURCE = `"""Focused native Nemotron profile fixture."""

from deepagents.profiles.harness.harness_profiles import _register_harness_profile_impl


def register() -> None:
    _register_harness_profile_impl(
        "${CANONICAL_MODEL_SPEC}", object()
    )
`;

const REGISTRY_IMPORT_ANCHOR =
  "from deepagents.profiles.harness.harness_profiles import _HARNESS_PROFILES\n";
const REGISTRY_IMPORT_PATCH = `from deepagents.profiles.harness.harness_profiles import (
    _HARNESS_PROFILES,
    _register_harness_profile_impl,
)
`;
const REGISTER_ANCHOR = "        _nvidia_nemotron_3_ultra.register()\n";
const REGISTER_PATCH = `        _nvidia_nemotron_3_ultra.register()
        # NemoClaw managed OpenAI-compatible Nemotron 3 Ultra aliases.
        _nemotron_ultra_profile = _HARNESS_PROFILES[
            "${CANONICAL_MODEL_SPEC}"
        ]
        _register_harness_profile_impl(
            "${MANAGED_MODEL_ALIASES[0]}", _nemotron_ultra_profile
        )
        _register_harness_profile_impl(
            "${MANAGED_MODEL_ALIASES[1]}", _nemotron_ultra_profile
        )
`;

const tempRoots: string[] = [];

type PatchFixture = {
  root: string;
  builtinPath: string;
  nativeProfilePath: string;
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function writeFixtureFile(root: string, relativePath: string, content: string): string {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
  return target;
}

function countOccurrences(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

function patchedBuiltinFixture(source: string): string {
  return source
    .replace(REGISTRY_IMPORT_ANCHOR, REGISTRY_IMPORT_PATCH)
    .replace(REGISTER_ANCHOR, REGISTER_PATCH);
}

function makePatchFixture(
  options: {
    dcode?: string;
    deepagents?: string;
    builtinSource?: string;
    nativeProfileSource?: string;
  } = {},
): PatchFixture {
  const dcodeVersion = options.dcode ?? EXPECTED_DCODE_VERSION;
  const deepagentsVersion = options.deepagents ?? EXPECTED_DEEPAGENTS_VERSION;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-nemotron-alias-"));
  tempRoots.push(root);

  writeFixtureFile(root, "deepagents_code/__init__.py", '"""DCode fixture."""\n');
  writeFixtureFile(root, "deepagents/__init__.py", '"""Deep Agents fixture."""\n');
  writeFixtureFile(root, "deepagents/profiles/__init__.py", '"""Profiles fixture."""\n');
  writeFixtureFile(root, "deepagents/profiles/harness/__init__.py", '"""Harness fixture."""\n');
  writeFixtureFile(
    root,
    "deepagents/profiles/harness/harness_profiles.py",
    `_HARNESS_PROFILES = {}

def _register_harness_profile_impl(key, profile):
    _HARNESS_PROFILES[key] = profile
`,
  );
  writeFixtureFile(root, "deepagents/profiles/provider/__init__.py", '"""Provider fixture."""\n');
  const builtinPath = writeFixtureFile(
    root,
    "deepagents/profiles/_builtin_profiles.py",
    options.builtinSource ?? BUILTIN_SOURCE,
  );
  const nativeProfilePath = writeFixtureFile(
    root,
    "deepagents/profiles/harness/_nvidia_nemotron_3_ultra.py",
    options.nativeProfileSource ?? NATIVE_PROFILE_SOURCE,
  );
  writeFixtureFile(
    root,
    `deepagents_code-${dcodeVersion}.dist-info/METADATA`,
    `Metadata-Version: 2.1\nName: deepagents-code\nVersion: ${dcodeVersion}\n`,
  );
  writeFixtureFile(
    root,
    `deepagents-${deepagentsVersion}.dist-info/METADATA`,
    `Metadata-Version: 2.1\nName: deepagents\nVersion: ${deepagentsVersion}\n`,
  );

  return { root, builtinPath, nativeProfilePath };
}

function prepareFixturePatcher(expectedBootstrap = BUILTIN_SOURCE): string {
  const scriptRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-nemotron-patcher-"));
  tempRoots.push(scriptRoot);
  const source = fs.readFileSync(patcherPath, "utf8");
  const testSource = source
    .replaceAll(NATIVE_PROFILE_SHA256, sha256(NATIVE_PROFILE_SOURCE))
    .replaceAll(PINNED_BUILTIN_SHA256, sha256(expectedBootstrap))
    .replace(
      /EXPECTED_PATCHED_BOOTSTRAP_SHA256\s*=\s*(?:\(\s*)?"[^"]+"(?:\s*\))?/,
      `EXPECTED_PATCHED_BOOTSTRAP_SHA256 = "${sha256(patchedBuiltinFixture(expectedBootstrap))}"`,
    );
  const testPatcher = path.join(scriptRoot, path.basename(patcherPath));
  fs.writeFileSync(testPatcher, testSource, "utf8");
  return testPatcher;
}

function runPatcher(fixture: PatchFixture, script = prepareFixturePatcher()) {
  return spawnSync("python3", [script], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, PYTHONPATH: fixture.root },
  });
}

function runBootstrapProbe(fixture: PatchFixture) {
  const script = `import importlib
import json
import sys

sys.path.insert(0, ${JSON.stringify(fixture.root)})
harness = importlib.import_module("deepagents.profiles.harness")
registry = importlib.import_module("deepagents.profiles.harness.harness_profiles")
provider = importlib.import_module("deepagents.profiles.provider")
events = []
canonical_profile = object()

class RegistrationModule:
    def __init__(self, name):
        self.name = name

    def register(self):
        events.append(self.name)
        if self.name == "nemotron":
            registry._HARNESS_PROFILES[${JSON.stringify(CANONICAL_MODEL_SPEC)}] = canonical_profile

for name in (
    "_anthropic_haiku_4_5",
    "_anthropic_opus_4_7",
    "_anthropic_sonnet_4_6",
    "_openai_codex",
):
    setattr(harness, name, RegistrationModule(name))
harness._nvidia_nemotron_3_ultra = RegistrationModule("nemotron")
provider._nvidia = RegistrationModule("nvidia")
provider._openai = RegistrationModule("openai")
provider._openrouter = RegistrationModule("openrouter")

bootstrap = importlib.import_module("deepagents.profiles._builtin_profiles")
bootstrap._ensure_builtin_profiles_loaded()
print(json.dumps({
    "events": events,
    "aliases_share_profile": all(
        registry._HARNESS_PROFILES[key] is canonical_profile
        for key in ${JSON.stringify(MANAGED_MODEL_ALIASES)}
    ),
}))
`;
  return spawnSync("python3", ["-c", script], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
}

function assertFixtureUnchanged(
  fixture: PatchFixture,
  expectedBootstrap: string,
  expectedProfile = NATIVE_PROFILE_SOURCE,
): void {
  expect(fs.readFileSync(fixture.builtinPath, "utf8")).toBe(expectedBootstrap);
  expect(fs.readFileSync(fixture.nativeProfilePath, "utf8")).toBe(expectedProfile);
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("LangChain Deep Agents Code Nemotron Ultra managed aliases", () => {
  it("pins the released package versions and official wheel source digests", () => {
    const patcher = fs.readFileSync(patcherPath, "utf8");

    for (const expected of [
      EXPECTED_DCODE_VERSION,
      EXPECTED_DEEPAGENTS_VERSION,
      NATIVE_PROFILE_SHA256,
      PINNED_BUILTIN_SHA256,
      PATCHED_BUILTIN_SHA256,
    ]) {
      expect(patcher).toContain(expected);
    }
    expect(patcher).toContain("native Nemotron profile source");
    expect(patcher).not.toContain("nemotron-ultra-harness-profile.py");
  });

  it("validates released-wheel graphs and parser/native managed dispatch parity", () => {
    const validator = fs.readFileSync(validatorPath, "utf8");

    for (const expected of [
      '"deepagents-code": "0.1.34"',
      '"deepagents": "0.7.0a6"',
      ...MANAGED_MODEL_ALIASES.map((alias) => `"${alias.replace(/^openai:/, "")}"`),
      "create_deep_agent(model=managed_models[0])",
      "validate_parser_tool_visibility()",
      "validate_parser_dispatch_parity()",
      "create_cli_agent(",
      "shell_allow_list",
      "graph.invoke(",
      "DISPATCH_COMMAND",
      '"NemotronProgressBudgetMiddleware"',
      '"FinalAnswerGuardMiddleware"',
    ]) {
      expect(validator).toContain(expected);
    }
    expect(validator).toContain("def require(condition: bool, message: str)");
    expect(validator).not.toMatch(/^\s*assert\b/m);
  });

  it("registers both aliases against the native profile atomically and idempotently", () => {
    const fixture = makePatchFixture();
    const script = prepareFixturePatcher();
    const originalProfile = fs.readFileSync(fixture.nativeProfilePath, "utf8");

    const first = runPatcher(fixture, script);
    expect(first.status, first.stderr).toBe(0);
    const patchedBootstrap = fs.readFileSync(fixture.builtinPath, "utf8");
    expect(fs.readFileSync(fixture.nativeProfilePath, "utf8")).toBe(originalProfile);
    expect(patchedBootstrap).toContain("    _register_harness_profile_impl,\n");
    expect(countOccurrences(patchedBootstrap, REGISTER_ANCHOR)).toBe(1);
    for (const alias of MANAGED_MODEL_ALIASES) {
      expect(countOccurrences(patchedBootstrap, alias)).toBe(1);
    }

    const probe = runBootstrapProbe(fixture);
    expect(probe.status, probe.stderr).toBe(0);
    const wiring = JSON.parse(probe.stdout) as {
      events: string[];
      aliases_share_profile: boolean;
    };
    expect(wiring.aliases_share_profile).toBe(true);
    expect(wiring.events.indexOf("nemotron")).toBeLessThan(wiring.events.indexOf("_openai_codex"));

    const second = runPatcher(fixture, script);
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain("managed-alias bridge is already applied");
    expect(fs.readFileSync(fixture.builtinPath, "utf8")).toBe(patchedBootstrap);
    expect(fs.readFileSync(fixture.nativeProfilePath, "utf8")).toBe(originalProfile);
    expect(fs.statSync(fixture.builtinPath).mode & 0o777).toBe(0o644);
  });

  it.each([
    ["Deep Agents Code", { dcode: "0.1.35" }, "deepagents-code==0.1.34"],
    ["Deep Agents", { deepagents: "0.7.0a7" }, "deepagents==0.7.0a6"],
  ] as const)("fails closed on %s version drift", (_label, versions, message) => {
    const fixture = makePatchFixture(versions);
    const result = runPatcher(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
    expect(result.stderr).toContain(
      "dependency drift requires reviewing whether upstream now recognizes both managed aliases",
    );
    assertFixtureUnchanged(fixture, BUILTIN_SOURCE);
  });

  it.each([
    ["registry import", REGISTRY_IMPORT_ANCHOR],
    ["native registration", REGISTER_ANCHOR],
  ] as const)("rejects a missing or duplicated %s anchor", (_label, anchor) => {
    for (const mode of ["missing", "duplicate"] as const) {
      const source =
        mode === "missing"
          ? BUILTIN_SOURCE.replace(anchor, "")
          : BUILTIN_SOURCE.replace(anchor, anchor + anchor);
      const fixture = makePatchFixture({ builtinSource: source });
      const result = runPatcher(fixture, prepareFixturePatcher(source));

      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/exactly one .* anchor/i);
      assertFixtureUnchanged(fixture, source);
    }
  });

  it.each([
    ["missing", (profilePath: string) => fs.rmSync(profilePath)],
    [
      "linked",
      (profilePath: string) => {
        fs.rmSync(profilePath);
        fs.symlinkSync("/dev/null", profilePath);
      },
    ],
    ["drifted", (profilePath: string) => fs.appendFileSync(profilePath, "# drift\n", "utf8")],
  ] as const)("rejects %s native profile source", (_label, mutateProfile) => {
    const fixture = makePatchFixture();
    mutateProfile(fixture.nativeProfilePath);
    const originalBootstrap = fs.readFileSync(fixture.builtinPath, "utf8");
    const result = runPatcher(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/native Nemotron profile|trusted regular file/i);
    expect(fs.readFileSync(fixture.builtinPath, "utf8")).toBe(originalBootstrap);
  });

  it("rejects drifted and partial bootstrap states without touching native source", () => {
    const driftedSource = `${BUILTIN_SOURCE}\n# bootstrap drift\n`;
    const drifted = makePatchFixture({ builtinSource: driftedSource });
    const driftResult = runPatcher(drifted);
    expect(driftResult.status).not.toBe(0);
    expect(driftResult.stderr).toMatch(/partial|conflicting|drifted/i);
    assertFixtureUnchanged(drifted, driftedSource);

    const partial = makePatchFixture();
    const script = prepareFixturePatcher();
    const first = runPatcher(partial, script);
    expect(first.status, first.stderr).toBe(0);
    const partialSource = `${fs.readFileSync(partial.builtinPath, "utf8")}# partial drift\n`;
    fs.writeFileSync(partial.builtinPath, partialSource, "utf8");
    const partialResult = runPatcher(partial, script);
    expect(partialResult.status).not.toBe(0);
    expect(partialResult.stderr).toMatch(/partial|conflicting|drifted/i);
    assertFixtureUnchanged(partial, partialSource);
  });

  it("leaves the bootstrap unchanged when the atomic temporary path is occupied", () => {
    const fixture = makePatchFixture();
    const temporary = path.join(
      path.dirname(fixture.builtinPath),
      "._builtin_profiles.py.nemoclaw-tmp",
    );
    fs.writeFileSync(temporary, "occupied\n", "utf8");

    const result = runPatcher(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("temporary patch path already exists");
    assertFixtureUnchanged(fixture, BUILTIN_SOURCE);
    expect(fs.readFileSync(temporary, "utf8")).toBe("occupied\n");
  });
});

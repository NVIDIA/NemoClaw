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
const vendoredProfilePath = path.join(agentDir, "nemotron-ultra-harness-profile.py");
const validatorPath = path.join(agentDir, "validate-nemotron-ultra-profile.py");

const EXPECTED_DCODE_VERSION = "0.1.30";
const EXPECTED_DEEPAGENTS_VERSION = "0.7.0a3";
const EXPECTED_UPSTREAM_SHA256 = "c8e8dd2b0182334b54be4f46ff0c7b45fbb95dc13bd9a92c249eb47a14fa13d7";
const PINNED_BUILTIN_SHA256 = "afe22b56d4d2e9fa6bc804bb4af27f5d47b6cb82d345afecebab74933214f389";
const PATCHED_BUILTIN_SHA256 = "e8da631665bc1a1cb461dc2aab435bf60dc8c297af3832af0923c4c4215bddae";
const CANONICAL_MODEL_SPEC = "nvidia:nvidia/nemotron-3-ultra-550b-a55b";
const MANAGED_MODEL_ALIASES = [
  "openai:nvidia/nemotron-3-ultra-550b-a55b",
  "openai:nvidia/nvidia/nemotron-3-ultra",
] as const;

// This fixture keeps the exact import and bootstrap anchors from deepagents
// 0.7.0a3 while remaining small enough for focused patch-boundary tests. The
// test-only patcher copy is given this fixture's digest below; a separate
// contract assertion preserves the real pinned package digest.
const BUILTIN_SOURCE = `"""Focused Deep Agents 0.7.0a3 built-in profile fixture."""

from __future__ import annotations

from deepagents.profiles.harness import (
    _anthropic_haiku_4_5,
    _anthropic_opus_4_7,
    _anthropic_sonnet_4_6,
    _openai_codex,
)
from deepagents.profiles.harness.harness_profiles import _HARNESS_PROFILES
from deepagents.profiles.provider import _openai, _openrouter


def _invoke_profile_plugins(group: str) -> None:
    del group


def _ensure_builtin_profiles_loaded() -> None:
    try:
        _openai.register()
        _openrouter.register()
        _anthropic_opus_4_7.register()
        _anthropic_sonnet_4_6.register()
        _anthropic_haiku_4_5.register()
        _openai_codex.register()
        _invoke_profile_plugins("deepagents.provider_profiles")
        _invoke_profile_plugins("deepagents.harness_profiles")
        frozenset(_HARNESS_PROFILES)
    except Exception:
        raise
`;

const HARNESS_IMPORT_ANCHOR = "    _openai_codex,\n";
const HARNESS_IMPORT_PATCH = "    _nvidia_nemotron_3_ultra,\n    _openai_codex,\n";
const REGISTRY_IMPORT_ANCHOR =
  "from deepagents.profiles.harness.harness_profiles import _HARNESS_PROFILES\n";
const REGISTRY_IMPORT_PATCH = `from deepagents.profiles.harness.harness_profiles import (
    _HARNESS_PROFILES,
    _register_harness_profile_impl,
)
`;
const REGISTER_ANCHOR = "        _openai_codex.register()\n";
const REGISTER_PATCH = `        # NemoClaw Nemotron 3 Ultra profile bridge (deepagents PR #4192).
        _nvidia_nemotron_3_ultra.register()
        _nemotron_ultra_profile = _HARNESS_PROFILES[
            "${CANONICAL_MODEL_SPEC}"
        ]
        _register_harness_profile_impl(
            "${MANAGED_MODEL_ALIASES[0]}", _nemotron_ultra_profile
        )
        _register_harness_profile_impl(
            "${MANAGED_MODEL_ALIASES[1]}", _nemotron_ultra_profile
        )
        _openai_codex.register()
`;

const tempRoots: string[] = [];

type PatchFixture = {
  root: string;
  builtinPath: string;
  destinationPath: string;
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

function patchedBuiltinFixture(): string {
  return BUILTIN_SOURCE.replace(HARNESS_IMPORT_ANCHOR, HARNESS_IMPORT_PATCH)
    .replace(REGISTRY_IMPORT_ANCHOR, REGISTRY_IMPORT_PATCH)
    .replace(REGISTER_ANCHOR, REGISTER_PATCH);
}

function makePatchFixture(versions: { dcode?: string; deepagents?: string } = {}): PatchFixture {
  const dcodeVersion = versions.dcode ?? EXPECTED_DCODE_VERSION;
  const deepagentsVersion = versions.deepagents ?? EXPECTED_DEEPAGENTS_VERSION;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-nemotron-profile-"));
  tempRoots.push(root);

  writeFixtureFile(root, "deepagents_code/__init__.py", '"""DCode fixture."""\n');
  writeFixtureFile(root, "deepagents/__init__.py", '"""Deep Agents fixture."""\n');
  writeFixtureFile(root, "deepagents/profiles/__init__.py", '"""Profiles fixture."""\n');
  writeFixtureFile(
    root,
    "deepagents/profiles/harness/__init__.py",
    '"""Harness profile fixture."""\n',
  );
  writeFixtureFile(
    root,
    "deepagents/profiles/harness/harness_profiles.py",
    `_HARNESS_PROFILES = {}\n
def _register_harness_profile_impl(key, profile):
    _HARNESS_PROFILES[key] = profile
`,
  );
  writeFixtureFile(root, "deepagents/profiles/provider/__init__.py", '"""Provider fixture."""\n');
  const builtinPath = writeFixtureFile(
    root,
    "deepagents/profiles/_builtin_profiles.py",
    BUILTIN_SOURCE,
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

  return {
    root,
    builtinPath,
    destinationPath: path.join(
      root,
      "deepagents",
      "profiles",
      "harness",
      "_nvidia_nemotron_3_ultra.py",
    ),
  };
}

function prepareFixturePatcher(options: { corruptSource?: boolean } = {}): string {
  const scriptRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-nemotron-patcher-"));
  tempRoots.push(scriptRoot);
  const source = fs.readFileSync(patcherPath, "utf8");
  expect(countOccurrences(source, PINNED_BUILTIN_SHA256)).toBeGreaterThanOrEqual(1);

  // The production script remains gated to the exact wheel source. Only this
  // private test copy swaps in the compact fixture digest.
  const originalFixtureHash = sha256(BUILTIN_SOURCE);
  const patchedFixtureHash = sha256(patchedBuiltinFixture());
  const testSource = source
    .replaceAll(PINNED_BUILTIN_SHA256, originalFixtureHash)
    .replace(
      /EXPECTED_PATCHED_BOOTSTRAP_SHA256\s*=\s*(?:\(\s*)?"[^"]+"(?:\s*\))?/,
      `EXPECTED_PATCHED_BOOTSTRAP_SHA256 = "${patchedFixtureHash}"`,
    );
  const testPatcher = path.join(scriptRoot, path.basename(patcherPath));
  fs.writeFileSync(testPatcher, testSource, "utf8");

  const vendoredSource = fs.readFileSync(vendoredProfilePath, "utf8");
  fs.writeFileSync(
    path.join(scriptRoot, path.basename(vendoredProfilePath)),
    options.corruptSource ? `${vendoredSource}\n# source drift\n` : vendoredSource,
    "utf8",
  );
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
registry_module = importlib.import_module(
    "deepagents.profiles.harness.harness_profiles"
)
provider = importlib.import_module("deepagents.profiles.provider")
events = []
canonical_profile = object()


class RegistrationModule:
    def __init__(self, name):
        self.name = name

    def register(self):
        events.append(self.name)
        if self.name == "nemotron":
            registry_module._HARNESS_PROFILES[${JSON.stringify(CANONICAL_MODEL_SPEC)}] = canonical_profile


for name in (
    "_anthropic_haiku_4_5",
    "_anthropic_opus_4_7",
    "_anthropic_sonnet_4_6",
    "_openai_codex",
):
    setattr(harness, name, RegistrationModule(name))
harness._nvidia_nemotron_3_ultra = RegistrationModule("nemotron")
provider._openai = RegistrationModule("openai")
provider._openrouter = RegistrationModule("openrouter")

bootstrap = importlib.import_module("deepagents.profiles._builtin_profiles")
bootstrap._ensure_builtin_profiles_loaded()
print(json.dumps({
    "events": events,
    "aliases_share_profile": all(
        registry_module._HARNESS_PROFILES[key] is canonical_profile
        for key in ${JSON.stringify(MANAGED_MODEL_ALIASES)}
    ),
}))
`;
  return spawnSync("python3", ["-c", script], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
}

function assertUnchanged(fixture: PatchFixture, originalBuiltin: string): void {
  expect(fs.readFileSync(fixture.builtinPath, "utf8")).toBe(originalBuiltin);
  expect(fs.existsSync(fixture.destinationPath)).toBe(false);
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("LangChain Deep Agents Code Nemotron Ultra profile patch", () => {
  it("pins the reviewed package versions and exact upstream sources", () => {
    const patcher = fs.readFileSync(patcherPath, "utf8");
    const vendoredProfile = fs.readFileSync(vendoredProfilePath);

    expect(patcher).toContain(EXPECTED_DCODE_VERSION);
    expect(patcher).toContain(EXPECTED_DEEPAGENTS_VERSION);
    expect(patcher).toContain(EXPECTED_UPSTREAM_SHA256);
    expect(patcher).toContain(PINNED_BUILTIN_SHA256);
    expect(patcher).toContain(PATCHED_BUILTIN_SHA256);
    expect(sha256(vendoredProfile)).toBe(EXPECTED_UPSTREAM_SHA256);
  });

  it("validates both managed ChatOpenAI aliases without making a request", () => {
    const validator = fs.readFileSync(validatorPath, "utf8");
    for (const expected of [
      '"deepagents-code": "0.1.30"',
      '"deepagents": "0.7.0a3"',
      ...MANAGED_MODEL_ALIASES.map((alias) => `"${alias.replace(/^openai:/, "")}"`),
      "ChatOpenAI(",
      "_harness_profile_for_model(model, None)",
      '"NemotronProgressBudgetMiddleware"',
      '"FinalAnswerGuardMiddleware"',
      "create_deep_agent(model=managed_models[0])",
      "validate_parser_tool_visibility()",
      '"execute"',
      '"write_file"',
      '"delete"',
      'blocked = NemotronTextToolCallParser._repair_message(message, {"read_file"})',
    ]) {
      expect(validator).toContain(expected);
    }
    expect(validator).not.toMatch(/\.(?:invoke|ainvoke|stream|astream)\(/);
  });

  it("installs the reviewed profile and managed aliases idempotently", () => {
    const fixture = makePatchFixture();
    const script = prepareFixturePatcher();

    const first = runPatcher(fixture, script);
    expect(first.status, first.stderr).toBe(0);
    const firstBuiltin = fs.readFileSync(fixture.builtinPath, "utf8");
    const firstProfile = fs.readFileSync(fixture.destinationPath, "utf8");

    expect(firstProfile).toBe(fs.readFileSync(vendoredProfilePath, "utf8"));
    expect(fs.statSync(fixture.builtinPath).mode & 0o777).toBe(0o644);
    expect(fs.statSync(fixture.destinationPath).mode & 0o777).toBe(0o644);
    expect(firstBuiltin).toContain("    _nvidia_nemotron_3_ultra,");
    expect(countOccurrences(firstBuiltin, "    _nvidia_nemotron_3_ultra,")).toBe(1);
    expect(firstBuiltin.indexOf("    _nvidia_nemotron_3_ultra,")).toBeLessThan(
      firstBuiltin.indexOf("    _openai_codex,"),
    );
    expect(firstBuiltin).toContain("    _register_harness_profile_impl,\n");

    const registerIndex = firstBuiltin.indexOf("        _nvidia_nemotron_3_ultra.register()\n");
    const profileBindingIndex = firstBuiltin.indexOf(
      "        _nemotron_ultra_profile = _HARNESS_PROFILES[\n",
    );
    const canonicalIndex = firstBuiltin.indexOf(`            "${CANONICAL_MODEL_SPEC}"\n`);
    const codexIndex = firstBuiltin.indexOf("        _openai_codex.register()\n");
    expect(registerIndex).toBeGreaterThan(-1);
    expect(profileBindingIndex).toBeGreaterThan(registerIndex);
    expect(canonicalIndex).toBeGreaterThan(profileBindingIndex);
    expect(codexIndex).toBeGreaterThan(profileBindingIndex);

    for (const alias of MANAGED_MODEL_ALIASES) {
      const aliasIndex = firstBuiltin.indexOf(`            "${alias}", _nemotron_ultra_profile\n`);
      expect(aliasIndex).toBeGreaterThan(profileBindingIndex);
      expect(aliasIndex).toBeLessThan(codexIndex);
      expect(countOccurrences(firstBuiltin, alias)).toBe(1);
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
    expect(fs.readFileSync(fixture.builtinPath, "utf8")).toBe(firstBuiltin);
    expect(fs.readFileSync(fixture.destinationPath, "utf8")).toBe(firstProfile);
  });

  it.each([
    ["Deep Agents Code", { dcode: "0.1.31" }, "deepagents-code==0.1.30"],
    ["Deep Agents", { deepagents: "0.7.0a4" }, "deepagents==0.7.0a3"],
  ] as const)("fails closed on the pinned %s version", (_label, versions, message) => {
    const fixture = makePatchFixture(versions);
    const originalBuiltin = fs.readFileSync(fixture.builtinPath, "utf8");
    const result = runPatcher(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
    assertUnchanged(fixture, originalBuiltin);
  });

  it.each([
    ["import", "    _openai_codex,\n"],
    ["registration", "        _openai_codex.register()\n"],
  ] as const)("fails closed when the exact %s anchor is missing or duplicated", (_label, anchor) => {
    for (const mode of ["missing", "duplicate"] as const) {
      const fixture = makePatchFixture();
      const original = fs.readFileSync(fixture.builtinPath, "utf8");
      fs.writeFileSync(
        fixture.builtinPath,
        mode === "missing"
          ? original.replace(anchor, "")
          : original.replace(anchor, anchor + anchor),
        "utf8",
      );
      const drifted = fs.readFileSync(fixture.builtinPath, "utf8");
      const result = runPatcher(fixture);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(
        /built-in|builtin|anchor|checksum|digest|source|partial|drift/i,
      );
      assertUnchanged(fixture, drifted);
    }
  });

  it("rejects a vendored profile whose reviewed upstream checksum drifts", () => {
    const fixture = makePatchFixture();
    const originalBuiltin = fs.readFileSync(fixture.builtinPath, "utf8");
    const result = runPatcher(fixture, prepareFixturePatcher({ corruptSource: true }));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/checksum|digest|sha|source/i);
    assertUnchanged(fixture, originalBuiltin);
  });

  it("refuses a conflicting installed profile without mutating bootstrap source", () => {
    const fixture = makePatchFixture();
    const originalBuiltin = fs.readFileSync(fixture.builtinPath, "utf8");
    writeFixtureFile(
      fixture.root,
      "deepagents/profiles/harness/_nvidia_nemotron_3_ultra.py",
      "# unexpected module\n",
    );
    const result = runPatcher(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/refus|unexpected|conflict/i);
    expect(fs.readFileSync(fixture.builtinPath, "utf8")).toBe(originalBuiltin);
    expect(fs.readFileSync(fixture.destinationPath, "utf8")).toBe("# unexpected module\n");
  });

  it("rejects an exact destination paired with an unpatched bootstrap", () => {
    const fixture = makePatchFixture();
    const originalBuiltin = fs.readFileSync(fixture.builtinPath, "utf8");
    fs.copyFileSync(vendoredProfilePath, fixture.destinationPath);
    const result = runPatcher(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/partial|mixed/i);
    expect(fs.readFileSync(fixture.builtinPath, "utf8")).toBe(originalBuiltin);
    expect(fs.readFileSync(fixture.destinationPath, "utf8")).toBe(
      fs.readFileSync(vendoredProfilePath, "utf8"),
    );
  });

  it("rejects a patched bootstrap when the installed profile disappears", () => {
    const fixture = makePatchFixture();
    const script = prepareFixturePatcher();
    const first = runPatcher(fixture, script);
    expect(first.status, first.stderr).toBe(0);
    fs.rmSync(fixture.destinationPath);
    const patchedBuiltin = fs.readFileSync(fixture.builtinPath, "utf8");

    const result = runPatcher(fixture, script);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/partial|missing|profile/i);
    expect(fs.readFileSync(fixture.builtinPath, "utf8")).toBe(patchedBuiltin);
    expect(fs.existsSync(fixture.destinationPath)).toBe(false);
  });
});

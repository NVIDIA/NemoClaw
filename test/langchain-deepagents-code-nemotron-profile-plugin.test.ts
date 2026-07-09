// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");
const agentDir = path.join(repoRoot, "agents", "langchain-deepagents-code");
const pluginProjectDir = path.join(agentDir, "profile-plugin");
const pluginSourcePath = path.join(
  pluginProjectDir,
  "src",
  "nemoclaw_deepagents_profile",
  "__init__.py",
);
const pluginProjectPath = path.join(pluginProjectDir, "pyproject.toml");
const validatorPath = path.join(agentDir, "validate-nemotron-ultra-profile.py");
const pythonBin = execFileSync("python3", ["-c", "import sys; print(sys.executable)"], {
  encoding: "utf8",
}).trim();

const EXPECTED_DCODE_VERSION = "0.1.34";
const EXPECTED_DEEPAGENTS_VERSION = "0.7.0a6";
const NATIVE_PROFILE_SHA256 = "c8e8dd2b0182334b54be4f46ff0c7b45fbb95dc13bd9a92c249eb47a14fa13d7";
const UNMODIFIED_BOOTSTRAP_SHA256 =
  "005a91e7fc4ca6b21220673dd9d02d6686bf63e1e4f1102d124b01f96886efcf";
const CANONICAL_MODEL_SPEC = "nvidia:nvidia/nemotron-3-ultra-550b-a55b";
const MANAGED_MODEL_ALIASES = [
  "openai:nvidia/nemotron-3-ultra-550b-a55b",
  "openai:nvidia/nvidia/nemotron-3-ultra",
] as const;

const NATIVE_PROFILE_SOURCE = `"""Focused native Nemotron profile fixture."""

NATIVE_PROFILE_MARKER = "reviewed"
`;

const BOOTSTRAP_SOURCE = `"""Focused unmodified Deep Agents bootstrap fixture."""

BOOTSTRAP_MARKER = "unmodified"
`;

const tempRoots: string[] = [];

type PluginFixture = {
  root: string;
  nativeProfilePath: string;
  bootstrapPath: string;
};

type ProbeResult = {
  aliases: boolean[];
  canonicalPresent: boolean;
  error: string | null;
  registryKeys: string[];
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function replaceHashDefinitions(
  source: string,
  replacements: readonly (readonly [name: string, currentHash: string, fixtureHash: string])[],
): string {
  // This test-only parser deliberately fails on source-shape drift or duplicate
  // definitions; replace it with an AST transform if the two-constant scope grows.
  return replacements.reduce((current, [name, currentHash, fixtureHash]) => {
    const definition = new RegExp(`(${name}\\s*=\\s*\\(\\s*)(["'])${currentHash}\\2(\\s*\\))`, "g");
    assert.equal(current.match(definition)?.length, 1, `expected exactly one ${name} definition`);
    return current.replace(definition, `$1$2${fixtureHash}$2$3`);
  }, source);
}

function writeFixtureFile(root: string, relativePath: string, content: string): string {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
  return target;
}

function makePluginFixture(
  options: {
    dcode?: string;
    deepagents?: string;
    nativeProfileSource?: string;
    bootstrapSource?: string;
  } = {},
): PluginFixture {
  const dcodeVersion = options.dcode ?? EXPECTED_DCODE_VERSION;
  const deepagentsVersion = options.deepagents ?? EXPECTED_DEEPAGENTS_VERSION;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-profile-plugin-fixture-"));
  tempRoots.push(root);

  writeFixtureFile(root, "deepagents_code/__init__.py", '"""DCode fixture."""\n');
  writeFixtureFile(root, "deepagents/__init__.py", '"""Deep Agents fixture."""\n');
  writeFixtureFile(
    root,
    "deepagents/profiles/__init__.py",
    "from deepagents.profiles.harness.harness_profiles import register_harness_profile\n",
  );
  writeFixtureFile(root, "deepagents/profiles/harness/__init__.py", '"""Harness fixture."""\n');
  writeFixtureFile(
    root,
    "deepagents/profiles/harness/harness_profiles.py",
    `import os

_HARNESS_PROFILES = {}


def register_harness_profile(key, profile):
    _HARNESS_PROFILES[key] = profile
    if os.environ.get("NEMOCLAW_TEST_FAIL_KEY") == key:
        raise RuntimeError(f"injected registration failure for {key}")
`,
  );
  const nativeProfilePath = writeFixtureFile(
    root,
    "deepagents/profiles/harness/_nvidia_nemotron_3_ultra.py",
    options.nativeProfileSource ?? NATIVE_PROFILE_SOURCE,
  );
  const bootstrapPath = writeFixtureFile(
    root,
    "deepagents/profiles/_builtin_profiles.py",
    options.bootstrapSource ?? BOOTSTRAP_SOURCE,
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

  return { root, nativeProfilePath, bootstrapPath };
}

function prepareFixturePlugin(
  nativeSource = NATIVE_PROFILE_SOURCE,
  bootstrapSource = BOOTSTRAP_SOURCE,
): string {
  const pluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-profile-plugin-source-"));
  tempRoots.push(pluginRoot);
  const source = replaceHashDefinitions(fs.readFileSync(pluginSourcePath, "utf8"), [
    ["EXPECTED_NATIVE_PROFILE_SHA256", NATIVE_PROFILE_SHA256, sha256(nativeSource)],
    ["EXPECTED_BOOTSTRAP_SHA256", UNMODIFIED_BOOTSTRAP_SHA256, sha256(bootstrapSource)],
  ]);
  return writeFixtureFile(pluginRoot, "nemoclaw_deepagents_profile/__init__.py", source);
}

function makeValidatorDependencyStubRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-profile-validator-stubs-"));
  tempRoots.push(root);
  const stubs = {
    "deepagents/__init__.py": "def create_deep_agent(*args, **kwargs): return object()\n",
    "deepagents/backends/__init__.py":
      "class LocalShellBackend:\n    def __init__(self, *args, **kwargs): pass\n",
    "deepagents/backends/protocol.py": "class ExecuteResponse: pass\n",
    "deepagents/profiles/__init__.py": "",
    "deepagents/profiles/harness/__init__.py": "",
    "deepagents/profiles/harness/_nvidia_nemotron_3_ultra.py":
      "class NemotronTextToolCallParser: pass\n",
    "deepagents/profiles/harness/harness_profiles.py":
      "class HarnessProfile: pass\ndef _harness_profile_for_model(*args, **kwargs): return HarnessProfile()\n",
    "deepagents_code/__init__.py": "",
    "deepagents_code/agent.py": "def create_cli_agent(*args, **kwargs): return None\n",
    "langchain/agents/middleware/types.py": "class AgentMiddleware: pass\n",
    "langchain_core/language_models/fake_chat_models.py": "class FakeMessagesListChatModel: pass\n",
    "langchain_core/messages.py":
      "class AIMessage: pass\nclass HumanMessage: pass\nclass ToolMessage: pass\n",
    "langchain_openai/__init__.py": "class ChatOpenAI: pass\n",
  };
  for (const [relativePath, content] of Object.entries(stubs)) {
    writeFixtureFile(root, relativePath, content);
  }
  return root;
}

function makeValidatorStubRoot(
  entryPointName: string,
  entryPointGroup = "deepagents.harness_profiles",
  licenseExpression = "Apache-2.0",
): string {
  const root = makeValidatorDependencyStubRoot();
  writeFixtureFile(
    root,
    "nemoclaw_deepagents_profile/__init__.py",
    fs.readFileSync(pluginSourcePath, "utf8"),
  );
  writeFixtureFile(
    root,
    "nemoclaw_deepagents_profile-0.1.0.dist-info/METADATA",
    `Metadata-Version: 2.4\nName: nemoclaw-deepagents-profile\nVersion: 0.1.0\nLicense-Expression: ${licenseExpression}\n`,
  );
  writeFixtureFile(
    root,
    "nemoclaw_deepagents_profile-0.1.0.dist-info/entry_points.txt",
    `[${entryPointGroup}]\n${entryPointName} = nemoclaw_deepagents_profile:register\n`,
  );
  return root;
}

function buildAndInstallPluginWheel(version: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-profile-wheel-"));
  tempRoots.push(root);
  const projectRoot = path.join(root, "project");
  const wheelDir = path.join(root, "wheel");
  const installRoot = path.join(root, "installed");
  fs.cpSync(pluginProjectDir, projectRoot, { recursive: true });
  fs.mkdirSync(wheelDir);
  const projectPath = path.join(projectRoot, "pyproject.toml");
  const project = fs.readFileSync(projectPath, "utf8");
  // invalidState: the runner's system setuptools predates PEP 639 strings.
  // sourceBoundary: this portable wheel exists only to test wrong-version
  // entry-point binding; production builds the unchanged project metadata.
  // whyNotSourceFix: the PEP 639 string is the standards-current source form.
  // regressionTest: the production validator requires License-Expression.
  // removalCondition: remove this conversion when runner setuptools supports it.
  const versionedProject = project
    .replace('version = "0.1.0"', `version = "${version}"`)
    .replace('license = "Apache-2.0"', 'license = { text = "Apache-2.0" }');
  assert.ok(
    versionedProject.includes(`version = "${version}"`),
    "fixture version was not replaced",
  );
  assert.ok(
    versionedProject.includes('license = { text = "Apache-2.0" }'),
    "fixture license was not replaced",
  );
  fs.writeFileSync(projectPath, versionedProject, "utf8");
  const pipEnv = {
    ...process.env,
    PIP_DISABLE_PIP_VERSION_CHECK: "1",
    PIP_NO_INPUT: "1",
  };
  execFileSync(
    pythonBin,
    [
      "-m",
      "pip",
      "wheel",
      "--no-cache-dir",
      "--no-deps",
      "--no-index",
      "--no-build-isolation",
      "--wheel-dir",
      wheelDir,
      projectRoot,
    ],
    { env: pipEnv, stdio: "pipe" },
  );
  const wheelPath = path.join(wheelDir, `nemoclaw_deepagents_profile-${version}-py3-none-any.whl`);
  execFileSync(
    pythonBin,
    [
      "-m",
      "pip",
      "install",
      "--no-cache-dir",
      "--no-deps",
      "--no-index",
      "--target",
      installRoot,
      wheelPath,
    ],
    { env: pipEnv, stdio: "pipe" },
  );
  return installRoot;
}

function runEntryPointValidationWithRoots(pythonRoots: string[]) {
  const script = `import importlib.util

spec = importlib.util.spec_from_file_location("nemoclaw_profile_validator", ${JSON.stringify(validatorPath)})
validator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(validator)
validator.validate_profile_entry_point()
`;
  return spawnSync(pythonBin, ["-S", "-c", script], {
    encoding: "utf8",
    env: {
      PATH: "/usr/bin:/bin",
      PYTHONPATH: pythonRoots.join(":"),
    },
  });
}

function runEntryPointValidation(
  entryPointName: string,
  entryPointGroup = "deepagents.harness_profiles",
) {
  return runEntryPointValidationWithRoots([makeValidatorStubRoot(entryPointName, entryPointGroup)]);
}

function runPlugin(
  fixture: PluginFixture,
  options: {
    additionalPythonRoots?: string[];
    aliasState?: "complete" | "conflict" | "partial";
    failKey?: string;
    registerCalls?: number;
    withCanonical?: boolean;
  } = {},
) {
  const pluginPath = prepareFixturePlugin();
  const pluginRoot = path.dirname(path.dirname(pluginPath));
  const script = `import json
from deepagents.profiles.harness.harness_profiles import _HARNESS_PROFILES

canonical = object()
if ${(options.withCanonical ?? true) ? "True" : "False"}:
    _HARNESS_PROFILES[${JSON.stringify(CANONICAL_MODEL_SPEC)}] = canonical

state = ${JSON.stringify(options.aliasState ?? "")}
aliases = ${JSON.stringify(MANAGED_MODEL_ALIASES)}
if state == "complete":
    for key in aliases:
        _HARNESS_PROFILES[key] = canonical
elif state == "partial":
    _HARNESS_PROFILES[aliases[0]] = canonical
elif state == "conflict":
    for key in aliases:
        _HARNESS_PROFILES[key] = object()

from nemoclaw_deepagents_profile import register

error = None
try:
    for _ in range(${options.registerCalls ?? 1}):
        register()
except Exception as exc:
    error = str(exc)

print(json.dumps({
    "aliases": [_HARNESS_PROFILES.get(key) is canonical for key in aliases],
    "canonicalPresent": _HARNESS_PROFILES.get(${JSON.stringify(CANONICAL_MODEL_SPEC)}) is canonical,
    "error": error,
    "registryKeys": sorted(_HARNESS_PROFILES),
}))
raise SystemExit(1 if error else 0)
`;
  const result = spawnSync(pythonBin, ["-c", script], {
    encoding: "utf8",
    env: {
      PATH: "/usr/bin:/bin",
      PYTHONPATH: [...(options.additionalPythonRoots ?? []), fixture.root, pluginRoot].join(":"),
      ...(options.failKey ? { NEMOCLAW_TEST_FAIL_KEY: options.failKey } : {}),
    },
  });
  return {
    ...result,
    probe: JSON.parse(result.stdout) as ProbeResult,
  };
}

function expectOfficialSourcesUnchanged(
  fixture: PluginFixture,
  nativeSource = NATIVE_PROFILE_SOURCE,
  bootstrapSource = BOOTSTRAP_SOURCE,
): void {
  expect(fs.readFileSync(fixture.nativeProfilePath, "utf8")).toBe(nativeSource);
  expect(fs.readFileSync(fixture.bootstrapPath, "utf8")).toBe(bootstrapSource);
}

const replaceProfileSource = {
  missing(sourcePath: string): void {
    fs.rmSync(sourcePath);
  },
  linked(sourcePath: string): void {
    fs.rmSync(sourcePath);
    fs.symlinkSync("/dev/null", sourcePath);
  },
};

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("LangChain Deep Agents Code managed Nemotron profile plugin (#6424)", () => {
  it("rewrites one exact hash definition across reviewed formatting variants", () => {
    const original = "a".repeat(64);
    const replacement = "b".repeat(64);
    const source = `EXPECTED_ONE = (\n  "${original}"\n)\nEXPECTED_TWO=( '${original}' )\n`;
    const result = replaceHashDefinitions(source, [
      ["EXPECTED_ONE", original, replacement],
      ["EXPECTED_TWO", original, replacement],
    ]);

    expect(result).not.toContain(original);
    expect(result.match(new RegExp(replacement, "g"))).toHaveLength(2);
    expect(() =>
      replaceHashDefinitions(`${source}EXPECTED_ONE = ("${original}")\n`, [
        ["EXPECTED_ONE", original, replacement],
      ]),
    ).toThrow(/expected exactly one EXPECTED_ONE definition/);
  });

  it("declares the supported Deep Agents harness-profile entry point", () => {
    const project = fs.readFileSync(pluginProjectPath, "utf8");

    expect(project).toContain('name = "nemoclaw-deepagents-profile"');
    expect(project).toContain('version = "0.1.0"');
    expect(project).toContain('requires = ["setuptools==82.0.1"]');
    expect(project).toContain('license = "Apache-2.0"');
    expect(project).toContain('[project.entry-points."deepagents.harness_profiles"]');
    expect(project).toContain('nemoclaw-managed-aliases = "nemoclaw_deepagents_profile:register"');
    expect(project).toContain('"deepagents-code==0.1.34"');
    expect(project).toContain('"deepagents==0.7.0a6"');
  });

  it("accepts the exact plugin, then rejects source substitution", () => {
    const root = makeValidatorStubRoot("nemoclaw-managed-aliases");
    expect(runEntryPointValidationWithRoots([root]).status).toBe(0);
    fs.appendFileSync(path.join(root, "nemoclaw_deepagents_profile", "__init__.py"), "# drift\n");

    const result = runEntryPointValidationWithRoots([root]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "profile plugin source does not match the reviewed first-party package",
    );
  });

  it("rejects a malicious wrong harness-profile entry point", () => {
    const result = runEntryPointValidation("wrong-managed-aliases");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "expected exactly one 'nemoclaw-managed-aliases' profile entry point",
    );
  });

  it("rejects unreviewed profile plugin license metadata", () => {
    const root = makeValidatorStubRoot(
      "nemoclaw-managed-aliases",
      "deepagents.harness_profiles",
      "MIT",
    );
    const result = runEntryPointValidationWithRoots([root]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "profile plugin license metadata does not match the reviewed package",
    );
  });

  it("rejects a plugin distribution missing the harness-profile entry-point group", () => {
    const result = runEntryPointValidation("nemoclaw-managed-aliases", "unrelated.entry_points");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "profile entry point group 'deepagents.harness_profiles' was not found",
    );
  });

  it("rejects an installed real plugin wheel with an unreviewed version", () => {
    const dependencyRoot = makeValidatorDependencyStubRoot();
    // A real wheel exercises entry-point metadata and locate_file binding that
    // a hand-written dist-info stub cannot prove.
    const installedPluginRoot = buildAndInstallPluginWheel("0.1.1");
    const result = runEntryPointValidationWithRoots([dependencyRoot, installedPluginRoot]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "profile entry point comes from an unexpected distribution version",
    );
  });

  it("idempotently registers both aliases without changing wheel sources", () => {
    const fixture = makePluginFixture();
    const result = runPlugin(fixture, { registerCalls: 2 });

    expect(result.status, result.stderr).toBe(0);
    expect(result.probe.aliases).toEqual([true, true]);
    expect(result.probe.canonicalPresent).toBe(true);
    expect(result.probe.registryKeys).toEqual(
      [...MANAGED_MODEL_ALIASES, CANONICAL_MODEL_SPEC].sort(),
    );
    expectOfficialSourcesUnchanged(fixture);
  });

  it.each([
    ["Deep Agents Code", { dcode: "0.1.35" }, "deepagents-code==0.1.34"],
    ["Deep Agents", { deepagents: "0.7.0a7" }, "deepagents==0.7.0a6"],
  ] as const)("fails closed on %s version drift", (_label, versions, message) => {
    const fixture = makePluginFixture(versions);
    const result = runPlugin(fixture);

    expect(result.status).not.toBe(0);
    expect(result.probe.error).toContain(message);
    expect(result.probe.aliases).toEqual([false, false]);
    expectOfficialSourcesUnchanged(fixture);
  });

  it("rejects a prepended shadow Deep Agents package before reading official sources", () => {
    const fixture = makePluginFixture();
    const shadowRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-shadow-deepagents-"));
    tempRoots.push(shadowRoot);
    writeFixtureFile(
      shadowRoot,
      "deepagents/__init__.py",
      "from pkgutil import extend_path\n__path__ = extend_path(__path__, __name__)\n",
    );
    const result = runPlugin(fixture, { additionalPythonRoots: [shadowRoot] });

    expect(result.status).not.toBe(0);
    expect(result.probe.error).toContain(
      "imported deepagents package does not match the reviewed distribution",
    );
    expect(result.probe.aliases).toEqual([false, false]);
    expectOfficialSourcesUnchanged(fixture);
  });

  it.each([
    ["native profile", "native"],
    ["bootstrap", "bootstrap"],
  ] as const)("rejects drifted %s source without changing either wheel file", (_label, target) => {
    const drift = "# drift\n";
    const nativeSource =
      target === "native" ? NATIVE_PROFILE_SOURCE + drift : NATIVE_PROFILE_SOURCE;
    const bootstrapSource = target === "bootstrap" ? BOOTSTRAP_SOURCE + drift : BOOTSTRAP_SOURCE;
    const fixture = makePluginFixture({
      nativeProfileSource: nativeSource,
      bootstrapSource,
    });
    const result = runPlugin(fixture);

    expect(result.status).not.toBe(0);
    expect(result.probe.error).toMatch(/does not match the reviewed Deep Agents/i);
    expect(result.probe.aliases).toEqual([false, false]);
    expectOfficialSourcesUnchanged(fixture, nativeSource, bootstrapSource);
  });

  it.each([
    ["missing", "native profile", "nativeProfilePath"],
    ["linked", "native profile", "nativeProfilePath"],
    ["missing", "bootstrap", "bootstrapPath"],
    ["linked", "bootstrap", "bootstrapPath"],
  ] as const)("rejects a %s %s source file", (mode, _label, sourceKey) => {
    const fixture = makePluginFixture();
    replaceProfileSource[mode](fixture[sourceKey]);

    const result = runPlugin(fixture);

    expect(result.status).not.toBe(0);
    expect(result.probe.error).toMatch(/not a trusted regular file/i);
    expect(result.probe.aliases).toEqual([false, false]);
  });

  it("rejects a missing canonical profile without creating aliases", () => {
    const fixture = makePluginFixture();
    const result = runPlugin(fixture, { withCanonical: false });

    expect(result.status).not.toBe(0);
    expect(result.probe.error).toContain("canonical profile");
    expect(result.probe.aliases).toEqual([false, false]);
    expect(result.probe.registryKeys).toEqual([]);
    expectOfficialSourcesUnchanged(fixture);
  });

  it.each([
    "partial",
    "conflict",
  ] as const)("rejects %s managed alias state without further registry changes", (aliasState) => {
    const fixture = makePluginFixture();
    const result = runPlugin(fixture, { aliasState });

    expect(result.status).not.toBe(0);
    expect(result.probe.error).toMatch(/partial|conflict/i);
    expect(result.probe.registryKeys).toHaveLength(aliasState === "partial" ? 2 : 3);
    expectOfficialSourcesUnchanged(fixture);
  });

  it("rolls back the first alias when the second registration fails", () => {
    const fixture = makePluginFixture();
    const result = runPlugin(fixture, { failKey: MANAGED_MODEL_ALIASES[1] });

    expect(result.status).not.toBe(0);
    expect(result.probe.error).toContain("injected registration failure");
    expect(result.probe.aliases).toEqual([false, false]);
    expect(result.probe.registryKeys).toEqual([CANONICAL_MODEL_SPEC]);
    expectOfficialSourcesUnchanged(fixture);
  });
});

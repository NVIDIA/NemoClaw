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
const e2eProfileCheckPath = path.join(
  repoRoot,
  "test",
  "e2e",
  "e2e-cloud-experimental",
  "checks",
  "03-deepagents-code-nemotron-ultra-profile.sh",
);
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
const MANAGED_MODEL_IDS = MANAGED_MODEL_ALIASES.map((alias) => alias.slice("openai:".length));

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
  aliasesShareManagedProfile: boolean;
  aliasMiddleware: string[];
  canonicalHasGuard: boolean;
  canonicalPresent: boolean;
  error: string | null;
  guardProbe: {
    async: {
      content: string;
      id: string;
      legacyText: string;
      name: string;
      status: string;
      text: string;
      calls: number;
    };
    concrete: { calls: number; command: string; result: string };
    internalWhitespace: {
      calls: number;
      content: string;
      id: string;
      status: string;
    };
    nonExecute: { calls: number; result: string };
    sync: {
      content: string;
      id: string;
      legacyText: string;
      name: string;
      status: string;
      text: string;
      calls: number;
    };
  } | null;
  registryKeys: string[];
  unrelatedPresent: boolean;
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function managedUltraModelIdsIn(source: string): string[] {
  return [
    ...new Set(source.match(/nvidia\/(?:nvidia\/)?nemotron-3-ultra(?:-550b-a55b)?/g) ?? []),
  ].sort();
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


class HarnessProfile:
    def __init__(self, *, extra_middleware=()):
        self.extra_middleware = list(extra_middleware)


def register_harness_profile(key, profile):
    existing = _HARNESS_PROFILES.get(key)
    if existing is None:
        _HARNESS_PROFILES[key] = profile
    else:
        _HARNESS_PROFILES[key] = HarnessProfile(
            extra_middleware=[*existing.extra_middleware, *profile.extra_middleware]
        )
    if os.environ.get("NEMOCLAW_TEST_FAIL_KEY") == key:
        raise RuntimeError(f"injected registration failure for {key}")
`,
  );
  writeFixtureFile(
    root,
    "langchain/agents/middleware/types.py",
    "class AgentMiddleware:\n    pass\n",
  );
  writeFixtureFile(
    root,
    "langchain_core/messages.py",
    `class TextAccessor(str):
    def __call__(self):
        return str(self)


class ToolMessage:
    def __init__(self, *, content, name, tool_call_id, status):
        self.content = content
        self.name = name
        self.tool_call_id = tool_call_id
        self.status = status

    @property
    def text(self):
        if isinstance(self.content, str):
            value = self.content
        else:
            value = "".join(
                block if isinstance(block, str) else block.get("text", "")
                for block in self.content
                if isinstance(block, str) or block.get("type") == "text"
            )
        return TextAccessor(value)
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
      "_HARNESS_PROFILES = {}\nclass HarnessProfile: pass\ndef _harness_profile_for_model(*args, **kwargs): return HarnessProfile()\n",
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
    concurrentRegisterCalls?: number;
    failKey?: string;
    probeGuard?: boolean;
    registerCalls?: number;
    withCanonical?: boolean;
    withUnrelated?: boolean;
  } = {},
) {
  const pluginPath = prepareFixturePlugin();
  const pluginRoot = path.dirname(path.dirname(pluginPath));
  const script = `import asyncio
import json
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from deepagents.profiles.harness.harness_profiles import HarnessProfile, _HARNESS_PROFILES

class NativeMiddleware:
    pass

canonical = HarnessProfile(extra_middleware=[NativeMiddleware()])
if ${(options.withCanonical ?? true) ? "True" : "False"}:
    _HARNESS_PROFILES[${JSON.stringify(CANONICAL_MODEL_SPEC)}] = canonical
unrelated = object()
if ${options.withUnrelated ? "True" : "False"}:
    _HARNESS_PROFILES["openai:gpt-4.1-mini"] = unrelated

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
    concurrent_calls = ${options.concurrentRegisterCalls ?? 0}
    if concurrent_calls:
        barrier = Barrier(concurrent_calls)

        def register_concurrently():
            barrier.wait()
            register()

        with ThreadPoolExecutor(max_workers=concurrent_calls) as executor:
            futures = [executor.submit(register_concurrently) for _ in range(concurrent_calls)]
            for future in futures:
                future.result()
    else:
        for _ in range(${options.registerCalls ?? 1}):
            register()
except Exception as exc:
    error = str(exc)

guard_probe = None
aliases_registered = [key in _HARNESS_PROFILES for key in aliases]
managed_profile = _HARNESS_PROFILES.get(aliases[0]) if all(aliases_registered) else None
alias_middleware = [
    type(item).__name__
    for item in getattr(managed_profile, "extra_middleware", ())
]
if error is None and ${options.probeGuard ? "True" : "False"}:
    guard = next(
        item
        for item in managed_profile.extra_middleware
        if type(item).__name__ == "NemoClawExecutePlaceholderGuardMiddleware"
    )

    class Request:
        def __init__(self, name, command, call_id):
            self.tool_call = {
                "name": name,
                "args": {"command": command},
                "id": call_id,
            }

    sync_calls = []
    sync_request = Request("execute", "  [CONTENT]  ", "sync-call")

    def sync_handler(request):
        sync_calls.append(request)
        return "sync-handler-result"

    sync_result = guard.wrap_tool_call(sync_request, sync_handler)

    async_calls = []
    async_request = Request("execute", "[content]", "async-call")

    async def async_handler(request):
        async_calls.append(request)
        return "async-handler-result"

    async_result = asyncio.run(guard.awrap_tool_call(async_request, async_handler))

    concrete_calls = []
    concrete_request = Request("execute", "printf concrete", "concrete-call")

    def concrete_handler(request):
        concrete_calls.append(request)
        return "concrete-handler-result"

    concrete_result = guard.wrap_tool_call(concrete_request, concrete_handler)

    internal_whitespace_calls = []
    internal_whitespace_request = Request(
        "execute", "\\t[  content  ]\\n", "internal-whitespace-call"
    )

    def internal_whitespace_handler(request):
        internal_whitespace_calls.append(request)
        return "internal-whitespace-handler-result"

    internal_whitespace_result = guard.wrap_tool_call(
        internal_whitespace_request, internal_whitespace_handler
    )

    non_execute_calls = []
    non_execute_request = Request("write_file", "[content]", "write-call")

    def non_execute_handler(request):
        non_execute_calls.append(request)
        return "non-execute-handler-result"

    non_execute_result = guard.wrap_tool_call(non_execute_request, non_execute_handler)
    guard_probe = {
        "sync": {
            "content": sync_result.content,
            "id": sync_result.tool_call_id,
            "legacyText": sync_result.text(),
            "name": sync_result.name,
            "status": sync_result.status,
            "text": str(sync_result.text),
            "calls": len(sync_calls),
        },
        "async": {
            "content": async_result.content,
            "id": async_result.tool_call_id,
            "legacyText": async_result.text(),
            "name": async_result.name,
            "status": async_result.status,
            "text": str(async_result.text),
            "calls": len(async_calls),
        },
        "concrete": {
            "calls": len(concrete_calls),
            "command": concrete_calls[0].tool_call["args"]["command"],
            "result": concrete_result,
        },
        "internalWhitespace": {
            "calls": len(internal_whitespace_calls),
            "content": internal_whitespace_result.content,
            "id": internal_whitespace_result.tool_call_id,
            "status": internal_whitespace_result.status,
        },
        "nonExecute": {
            "calls": len(non_execute_calls),
            "result": non_execute_result,
        },
    }

print(json.dumps({
    "aliases": aliases_registered,
    "aliasesShareManagedProfile": (
        all(aliases_registered)
        and _HARNESS_PROFILES[aliases[0]] is _HARNESS_PROFILES[aliases[1]]
    ),
    "aliasMiddleware": alias_middleware,
    "canonicalHasGuard": any(
        type(item).__name__ == "NemoClawExecutePlaceholderGuardMiddleware"
        for item in canonical.extra_middleware
    ),
    "canonicalPresent": _HARNESS_PROFILES.get(${JSON.stringify(CANONICAL_MODEL_SPEC)}) is canonical,
    "error": error,
    "guardProbe": guard_probe,
    "registryKeys": sorted(_HARNESS_PROFILES),
    "unrelatedPresent": _HARNESS_PROFILES.get("openai:gpt-4.1-mini") is unrelated,
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

  it("keeps language-local managed Ultra model ID allowlists in sync", () => {
    const expected = [...MANAGED_MODEL_IDS].sort();
    for (const sourcePath of [
      path.join(agentDir, "generate-config.ts"),
      validatorPath,
      pluginSourcePath,
      e2eProfileCheckPath,
    ]) {
      const source = fs.readFileSync(sourcePath, "utf8");
      expect(managedUltraModelIdsIn(source), path.relative(repoRoot, sourcePath)).toEqual(expected);
    }
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
    expect(result.probe.aliasesShareManagedProfile).toBe(true);
    expect(result.probe.aliasMiddleware).toEqual([
      "NativeMiddleware",
      "NemoClawExecutePlaceholderGuardMiddleware",
    ]);
    expect(result.probe.canonicalHasGuard).toBe(false);
    expect(result.probe.canonicalPresent).toBe(true);
    expect(result.probe.registryKeys).toEqual(
      [...MANAGED_MODEL_ALIASES, CANONICAL_MODEL_SPEC].sort(),
    );
    expectOfficialSourcesUnchanged(fixture);
  });

  it("atomically registers one managed profile when plugin discovery races", () => {
    const fixture = makePluginFixture();
    const result = runPlugin(fixture, { concurrentRegisterCalls: 8 });

    expect(result.status, result.stderr).toBe(0);
    expect(result.probe.aliases).toEqual([true, true]);
    expect(result.probe.aliasesShareManagedProfile).toBe(true);
    expect(result.probe.aliasMiddleware).toEqual([
      "NativeMiddleware",
      "NemoClawExecutePlaceholderGuardMiddleware",
    ]);
    expect(result.probe.canonicalHasGuard).toBe(false);
    expect(result.probe.canonicalPresent).toBe(true);
    expect(result.probe.registryKeys).toEqual(
      [...MANAGED_MODEL_ALIASES, CANONICAL_MODEL_SPEC].sort(),
    );
    expectOfficialSourcesUnchanged(fixture);
  });

  it("rejects execute placeholder whitespace variants before sync and async dispatch", () => {
    const fixture = makePluginFixture();
    const result = runPlugin(fixture, { probeGuard: true });

    expect(result.status, result.stderr).toBe(0);
    expect(result.probe.guardProbe).not.toBeNull();
    expect(result.probe.guardProbe?.sync).toMatchObject({
      id: "sync-call",
      name: "execute",
      status: "error",
      calls: 0,
    });
    expect(result.probe.guardProbe?.sync.content).toContain("placeholder '[content]'");
    expect(result.probe.guardProbe?.sync.content).toContain("complete command");
    expect(result.probe.guardProbe?.sync.text).toBe(result.probe.guardProbe?.sync.content);
    expect(result.probe.guardProbe?.sync.legacyText).toBe(result.probe.guardProbe?.sync.content);
    expect(result.probe.guardProbe?.async).toMatchObject({
      id: "async-call",
      name: "execute",
      status: "error",
      calls: 0,
    });
    expect(result.probe.guardProbe?.async.content).toContain("placeholder '[content]'");
    expect(result.probe.guardProbe?.async.content).toContain("complete command");
    expect(result.probe.guardProbe?.async.text).toBe(result.probe.guardProbe?.async.content);
    expect(result.probe.guardProbe?.async.legacyText).toBe(result.probe.guardProbe?.async.content);
    expect(result.probe.guardProbe?.concrete).toEqual({
      calls: 1,
      command: "printf concrete",
      result: "concrete-handler-result",
    });
    expect(result.probe.guardProbe?.internalWhitespace).toMatchObject({
      calls: 0,
      id: "internal-whitespace-call",
      status: "error",
    });
    expect(result.probe.guardProbe?.internalWhitespace.content).toContain(
      "placeholder '[content]'",
    );
    expect(result.probe.guardProbe?.nonExecute).toEqual({
      calls: 1,
      result: "non-execute-handler-result",
    });
    expectOfficialSourcesUnchanged(fixture);
  });

  it("pins guard validators to the ToolMessage string-content API", () => {
    const requirements = fs.readFileSync(path.join(agentDir, "requirements.lock"), "utf8");
    const validator = fs.readFileSync(validatorPath, "utf8");
    const e2eCheck = fs.readFileSync(e2eProfileCheckPath, "utf8");

    expect(requirements).toMatch(/^langchain-core==1\.4\.8 /m);
    for (const source of [validator, e2eCheck]) {
      expect(source).toContain("isinstance(sync_result.content, str)");
      expect(source).toContain("isinstance(async_result.content, str)");
      expect(source).toContain('"complete command" in sync_result.content');
      expect(source).toContain('"complete command" in async_result.content');
      expect(source).not.toContain("sync_result.text");
      expect(source).not.toContain("async_result.text");
    }
  });

  it("resolves a managed model before the E2E probe inspects lazy profile state", () => {
    const e2eCheck = fs.readFileSync(e2eProfileCheckPath, "utf8");
    const managedResolution = e2eCheck.indexOf(
      "_harness_profile_for_model(make_model(model_id), None)",
    );
    const canonicalLookup = e2eCheck.indexOf("canonical_profile = _HARNESS_PROFILES[");

    expect(managedResolution).toBeGreaterThan(-1);
    expect(canonicalLookup).toBeGreaterThan(managedResolution);
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
    const result = runPlugin(fixture, {
      failKey: MANAGED_MODEL_ALIASES[1],
      withUnrelated: true,
    });

    expect(result.status).not.toBe(0);
    expect(result.probe.error).toContain("injected registration failure");
    expect(result.probe.aliases).toEqual([false, false]);
    expect(result.probe.unrelatedPresent).toBe(true);
    expect(result.probe.registryKeys).toEqual([CANONICAL_MODEL_SPEC, "openai:gpt-4.1-mini"].sort());
    expectOfficialSourcesUnchanged(fixture);
  });
});

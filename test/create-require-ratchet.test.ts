// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";

import {
  collectCreateRequireInventory,
  containsCreateRequireIdentifier,
  createRequireInventoryFailure,
  extractPullRequestBaseSha,
  extractTrustedCreateRequireAllowlists,
  type GitRunner,
  requireSingleBaseChecker,
  requireSingleCurrentChecker,
  resolveBaseRevision,
  trustedCreateRequireExpansionFailure,
  verifyTrustedCreateRequireRatchet,
} from "../.github/actions/ci-static-checks/create-require-ratchet-core.mts";

const BASE_SHA = "a".repeat(40);
const temporaryRoots: string[] = [];

function temporaryRepo(): string {
  const root = mkdtempSync(path.join(tmpdir(), "nemoclaw-create-require-ratchet-"));
  temporaryRoots.push(root);
  return root;
}

function writeFixture(root: string, relativePath: string, source: string): void {
  const absolutePath = path.join(root, relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, source);
}

function allowlistSource(
  cli: readonly string[] = [],
  testSupport: readonly string[] = [],
  extraSource = "",
): string {
  return [
    `export const CLI_CREATE_REQUIRE_FILES = ${JSON.stringify(cli)} as const;`,
    `export const TEST_SUPPORT_CREATE_REQUIRE_FILES = ${JSON.stringify(testSupport)} as const;`,
    extraSource,
  ].join("\n");
}

function pullRequestEnvironment(root: string, revision = BASE_SHA): NodeJS.ProcessEnv {
  const eventPath = path.join(root, "event.json");
  writeFileSync(eventPath, JSON.stringify({ pull_request: { base: { sha: revision } } }));
  return { GITHUB_BASE_REF: "main", GITHUB_EVENT_PATH: eventPath };
}

function baseRunner(
  sources: Partial<Record<"mts" | "ts", string>>,
  revision = BASE_SHA,
): GitRunner {
  return (args) => {
    switch (args[0]) {
      case "cat-file":
        return {
          status: args[2] === `${revision}^{commit}` ? 0 : 128,
          stderr: "",
          stdout: "",
        };
      case "show": {
        const requestedPath = args[1]?.slice(revision.length + 1);
        const extension = requestedPath?.endsWith(".mts") ? "mts" : "ts";
        const source = sources[extension];
        return source === undefined
          ? { status: 128, stderr: "missing", stdout: "" }
          : { status: 0, stderr: "", stdout: source };
      }
      default:
        throw new Error(`unexpected git arguments: ${args.join(" ")}`);
    }
  };
}

function runFixtureGit(repoRoot: string, args: readonly string[]): string {
  const result = spawnSync("git", [...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 5_000,
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

function copyTrustedEntrypoint(actionRoot: string): string {
  const sourceRoot = path.resolve(".github/actions/ci-static-checks");
  mkdirSync(path.join(actionRoot, "node_modules"), { recursive: true });
  for (const file of ["create-require-ratchet.mts", "create-require-ratchet-core.mts"]) {
    copyFileSync(path.join(sourceRoot, file), path.join(actionRoot, file));
  }
  symlinkSync(
    path.resolve("node_modules/typescript"),
    path.join(actionRoot, "node_modules/typescript"),
    process.platform === "win32" ? "junction" : "dir",
  );
  return path.join(actionRoot, "create-require-ratchet.mts");
}

function runTrustedEntrypoint(
  entrypoint: string,
  repoRoot: string,
  environment: NodeJS.ProcessEnv,
) {
  return spawnSync(process.execPath, ["--experimental-strip-types", entrypoint], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...environment, GITHUB_WORKSPACE: repoRoot },
    timeout: 10_000,
  });
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("base-trusted createRequire ratchet", () => {
  it("extracts only top-level exported const literal allowlists exactly once (#7056)", () => {
    const source = allowlistSource(["src/a.test.ts"], ["test/helper.ts"]);
    expect(extractTrustedCreateRequireAllowlists(ts, source, "checker.ts")).toEqual({
      cli: ["src/a.test.ts"],
      testSupport: ["test/helper.ts"],
    });

    expect(() =>
      extractTrustedCreateRequireAllowlists(
        ts,
        [
          "const dynamicPath = getPath();",
          "export const CLI_CREATE_REQUIRE_FILES = [dynamicPath] as const;",
          "export const TEST_SUPPORT_CREATE_REQUIRE_FILES = [] as const;",
        ].join("\n"),
        "checker.ts",
      ),
    ).toThrow("CLI_CREATE_REQUIRE_FILES must be a literal string array");
    expect(() =>
      extractTrustedCreateRequireAllowlists(
        ts,
        allowlistSource([], []).replace("export const CLI", "const CLI"),
        "checker.ts",
      ),
    ).toThrow("CLI_CREATE_REQUIRE_FILES must be a top-level exported const");
    expect(() =>
      extractTrustedCreateRequireAllowlists(
        ts,
        `${allowlistSource([], [])}\nexport const CLI_CREATE_REQUIRE_FILES = [] as const;`,
        "checker.ts",
      ),
    ).toThrow("CLI_CREATE_REQUIRE_FILES must be declared exactly once");
  });

  it("fails closed on malformed checker syntax (#7056)", () => {
    expect(() =>
      extractTrustedCreateRequireAllowlists(ts, `${allowlistSource([], [])}\nif (`, "checker.ts"),
    ).toThrow("checker.ts has TypeScript parse diagnostics");
  });

  it("detects executable identifiers while ignoring inert literal text (#7056)", () => {
    expect(
      containsCreateRequireIdentifier(
        ts,
        'import { createRequire } from "node:module";\ncreateRequire(import.meta.url);',
        "example.ts",
      ),
    ).toBe(true);
    expect(
      containsCreateRequireIdentifier(
        ts,
        'nodeModule["create" + "Require"](import.meta.url);',
        "example.ts",
      ),
    ).toBe(true);
    expect(
      containsCreateRequireIdentifier(
        ts,
        'const boundary = { ["createRequire"]: load };',
        "example.ts",
      ),
    ).toBe(true);
    expect(
      containsCreateRequireIdentifier(
        ts,
        [
          "// createRequire is documentation",
          'const quoted = "createRequire(import.meta.url)";',
          "const template = `createRequire text`;",
          "const jsx = <div>createRequire</div>;",
        ].join("\n"),
        "example.tsx",
      ),
    ).toBe(false);
  });

  it("folds static template property names without flagging dynamic access (#7056)", () => {
    expect(
      containsCreateRequireIdentifier(
        ts,
        'nodeModule[`create${"Require"}`](import.meta.url);',
        "example.ts",
      ),
    ).toBe(true);
    expect(
      containsCreateRequireIdentifier(
        ts,
        "nodeModule[`create${suffix}`](import.meta.url);",
        "example.ts",
      ),
    ).toBe(false);
  });

  it("detects quoted node-module bindings without flagging unrelated properties (#7056)", () => {
    expect(
      containsCreateRequireIdentifier(
        ts,
        [
          'import * as nodeModule from "node:module";',
          'const { "createRequire": load } = nodeModule;',
          "load(import.meta.url);",
        ].join("\n"),
        "example.ts",
      ),
    ).toBe(true);
    expect(
      containsCreateRequireIdentifier(
        ts,
        'import { "createRequire" as load } from "node:module";\nload(import.meta.url);',
        "example.ts",
      ),
    ).toBe(true);
    expect(
      containsCreateRequireIdentifier(
        ts,
        [
          'import * as fixture from "./fixture.js";',
          'const { "createRequire": load } = fixture;',
          "load();",
        ].join("\n"),
        "example.ts",
      ),
    ).toBe(false);
    expect(
      containsCreateRequireIdentifier(
        ts,
        'import { "createRequire" as load } from "./fixture.js";\nload();',
        "example.ts",
      ),
    ).toBe(false);
  });

  it("resolves node-module object aliases without trusting shadowed or cyclic decoys (#7056)", () => {
    expect(
      containsCreateRequireIdentifier(
        ts,
        [
          'const moduleObject = await import("node:module");',
          'const { "createRequire": load } = moduleObject;',
          "export const requireFromHere = load(import.meta.url);",
        ].join("\n"),
        "dynamic-alias.ts",
      ),
    ).toBe(true);
    expect(
      containsCreateRequireIdentifier(
        ts,
        [
          'import * as nodeModule from "node:module";',
          "const moduleObject = nodeModule;",
          'const { "createRequire": load } = moduleObject;',
          "export const requireFromHere = load(import.meta.url);",
        ].join("\n"),
        "namespace-alias.ts",
      ),
    ).toBe(true);
    expect(
      containsCreateRequireIdentifier(
        ts,
        [
          'import * as nodeModule from "node:module";',
          "function inspect(nodeModule: object) {",
          "  const moduleObject = nodeModule;",
          '  const { "createRequire": load } = moduleObject;',
          "  return load;",
          "}",
        ].join("\n"),
        "shadowed-alias.ts",
      ),
    ).toBe(false);
    expect(
      containsCreateRequireIdentifier(
        ts,
        [
          'const fixture = { "createRequire": () => undefined };',
          "const moduleObject = fixture;",
          'const { "createRequire": load } = moduleObject;',
          "load();",
        ].join("\n"),
        "unrelated-alias.ts",
      ),
    ).toBe(false);
    expect(
      containsCreateRequireIdentifier(
        ts,
        [
          "const first = second;",
          "const second = first;",
          'const { "createRequire": load } = first;',
          "load();",
        ].join("\n"),
        "cyclic-alias.ts",
      ),
    ).toBe(false);
  });

  it("fails closed on symbolic links under scoped scan roots (#7056)", () => {
    const root = temporaryRepo();
    writeFixture(root, "payload.ts", "createRequire(import.meta.url);");
    mkdirSync(path.join(root, "src/lib"), { recursive: true });
    symlinkSync(path.join(root, "payload.ts"), path.join(root, "src/lib/linked.test.ts"));
    expect(() => collectCreateRequireInventory(ts, root)).toThrow(
      "createRequire inventory does not permit scoped symbolic links",
    );
  });

  it("fails closed on malformed scanned TypeScript (#7056)", () => {
    const root = temporaryRepo();
    writeFixture(root, "src/lib/broken.ts", "export function broken(");
    expect(() => collectCreateRequireInventory(ts, root)).toThrow(
      "broken.ts has TypeScript parse diagnostics",
    );
  });

  it("collects only the scoped CLI, production, and support uses (#7056)", () => {
    const root = temporaryRepo();
    writeFixture(root, "src/lib/allowed.test.ts", "createRequire(import.meta.url);");
    writeFixture(root, "src/lib/production.ts", "nodeModule.createRequire(import.meta.url);");
    writeFixture(root, "test/helpers/support.ts", "const createRequire = factory;");
    writeFixture(root, "test/ignored.test.ts", "createRequire(import.meta.url);");
    writeFixture(root, "src/lib/inert.ts", 'const value = "createRequire";');

    expect(collectCreateRequireInventory(ts, root)).toEqual({
      cli: ["src/lib/allowed.test.ts"],
      production: ["src/lib/production.ts"],
      testSupport: ["test/helpers/support.ts"],
    });
  });

  it("rejects unchanged declarations when actual CLI use is added (#7056)", () => {
    const root = temporaryRepo();
    writeFixture(root, "src/lib/new-boundary.test.ts", "createRequire(import.meta.url);");
    const failure = createRequireInventoryFailure(collectCreateRequireInventory(ts, root), {
      cli: [],
      testSupport: [],
    });
    expect(failure).toContain("CLI_CREATE_REQUIRE_FILES omits actual createRequire use");
    expect(failure).toContain("src/lib/new-boundary.test.ts");
  });

  it("rejects alternate runtime lists and early returns that hide actual use (#7056)", () => {
    const root = temporaryRepo();
    writeFixture(
      root,
      "scripts/checks/test-create-require-budget.ts",
      allowlistSource(
        [],
        [],
        [
          'const alternateFiles = ["src/lib/hidden.test.ts"];',
          "function main() { return; use(alternateFiles); }",
        ].join("\n"),
      ),
    );
    writeFixture(root, "src/lib/hidden.test.ts", "createRequire(import.meta.url);");
    const failure = verifyTrustedCreateRequireRatchet(
      ts,
      root,
      pullRequestEnvironment(root),
      baseRunner({ ts: allowlistSource([], []) }),
    );
    expect(failure).toContain("src/lib/hidden.test.ts");
  });

  it("rejects latent declarations without corresponding actual use (#7056)", () => {
    const failure = createRequireInventoryFailure(
      { cli: [], production: [], testSupport: [] },
      { cli: ["src/lib/latent.test.ts"], testSupport: ["test/helpers/latent.ts"] },
    );
    expect(failure).toContain("CLI_CREATE_REQUIRE_FILES contains paths without actual");
    expect(failure).toContain("TEST_SUPPORT_CREATE_REQUIRE_FILES contains paths without actual");
  });

  it("rejects production and undeclared support use (#7056)", () => {
    const failure = createRequireInventoryFailure(
      {
        cli: [],
        production: ["src/lib/production.ts"],
        testSupport: ["test/helpers/new-support.ts"],
      },
      { cli: [], testSupport: [] },
    );
    expect(failure).toContain("Production TypeScript must not introduce createRequire boundaries");
    expect(failure).toContain("TEST_SUPPORT_CREATE_REQUIRE_FILES omits actual createRequire use");
  });

  it("rejects additions relative to the trusted base while permitting removals (#7056)", () => {
    expect(
      trustedCreateRequireExpansionFailure(
        { cli: ["src/a.test.ts"], testSupport: [] },
        { cli: ["src/a.test.ts", "src/retired.test.ts"], testSupport: ["test/retired.ts"] },
      ),
    ).toBeNull();
    expect(
      trustedCreateRequireExpansionFailure(
        { cli: ["src/a.test.ts", "src/new.test.ts"], testSupport: ["test/new.ts"] },
        { cli: ["src/a.test.ts"], testSupport: [] },
      ),
    ).toBe(
      [
        "createRequire allowlists must not expand relative to the trusted base.",
        "- CLI_CREATE_REQUIRE_FILES: src/new.test.ts",
        "- TEST_SUPPORT_CREATE_REQUIRE_FILES: test/new.ts",
      ].join("\n"),
    );
  });

  it("requires exactly one current and one base checker (#7056)", () => {
    const root = temporaryRepo();
    writeFixture(root, "scripts/checks/test-create-require-budget.ts", allowlistSource([], []));
    writeFixture(root, "scripts/checks/test-create-require-budget.mts", allowlistSource([], []));
    expect(() => requireSingleCurrentChecker(root)).toThrow(
      "current checkout must contain exactly one createRequire budget checker; found 2",
    );
    expect(() =>
      requireSingleBaseChecker(
        baseRunner({ ts: allowlistSource([], []), mts: allowlistSource([], []) }),
        BASE_SHA,
      ),
    ).toThrow("trusted base must contain exactly one createRequire budget checker; found 2");
  });

  it("allows a clean one-file checker extension migration (#7056)", () => {
    const root = temporaryRepo();
    const paths = ["src/lib/allowed.test.ts"];
    writeFixture(root, "scripts/checks/test-create-require-budget.mts", allowlistSource(paths, []));
    writeFixture(root, paths[0], "createRequire(import.meta.url);");

    expect(
      verifyTrustedCreateRequireRatchet(
        ts,
        root,
        pullRequestEnvironment(root),
        baseRunner({ ts: allowlistSource(paths, []) }),
      ),
    ).toBeNull();
  });

  it("executes the committed Node entrypoint and rejects a static template expansion (#7056)", () => {
    const root = temporaryRepo();
    const repoRoot = path.join(root, "checkout");
    const entrypoint = copyTrustedEntrypoint(path.join(root, "trusted-action"));
    const originalPath = "src/lib/allowed.test.ts";
    const expandedPath = "src/lib/expanded.test.ts";
    mkdirSync(repoRoot, { recursive: true });
    runFixtureGit(repoRoot, ["init", "--initial-branch=main"]);
    writeFixture(
      repoRoot,
      "scripts/checks/test-create-require-budget.ts",
      allowlistSource([originalPath], []),
    );
    writeFixture(repoRoot, originalPath, "createRequire(import.meta.url);");
    runFixtureGit(repoRoot, ["add", "."]);
    runFixtureGit(repoRoot, [
      "-c",
      "user.name=NemoClaw Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "test: create fixture base",
    ]);
    const baseRevision = runFixtureGit(repoRoot, ["rev-parse", "HEAD"]);
    const environment = pullRequestEnvironment(repoRoot, baseRevision);

    const passing = runTrustedEntrypoint(entrypoint, repoRoot, environment);
    expect(passing.status, passing.stderr).toBe(0);
    expect(passing.stdout, `stderr: ${passing.stderr}`).toContain(
      "Base-trusted createRequire allowlist ratchet passed.",
    );

    writeFixture(
      repoRoot,
      "scripts/checks/test-create-require-budget.ts",
      allowlistSource([originalPath, expandedPath], []),
    );
    writeFixture(repoRoot, expandedPath, 'nodeModule[`create${"Require"}`](import.meta.url);');
    const failing = runTrustedEntrypoint(entrypoint, repoRoot, environment);
    expect(failing.status).toBe(1);
    expect(failing.stderr).toContain(
      "createRequire allowlists must not expand relative to the trusted base.",
    );
    expect(failing.stderr).toContain(`- CLI_CREATE_REQUIRE_FILES: ${expandedPath}`);
  });

  it("executes the committed entrypoint against node-module object aliases (#7056)", () => {
    const root = temporaryRepo();
    const repoRoot = path.join(root, "checkout");
    const entrypoint = copyTrustedEntrypoint(path.join(root, "trusted-action"));
    mkdirSync(repoRoot, { recursive: true });
    runFixtureGit(repoRoot, ["init", "--initial-branch=main"]);
    writeFixture(repoRoot, "scripts/checks/test-create-require-budget.ts", allowlistSource([], []));
    writeFixture(
      repoRoot,
      "src/lib/fixture-property.ts",
      [
        'const fixture = { "createRequire": () => undefined };',
        'const { "createRequire": load } = fixture;',
        "load();",
      ].join("\n"),
    );
    runFixtureGit(repoRoot, ["add", "."]);
    runFixtureGit(repoRoot, [
      "-c",
      "user.name=NemoClaw Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "test: create fixture base",
    ]);
    const baseRevision = runFixtureGit(repoRoot, ["rev-parse", "HEAD"]);
    const environment = pullRequestEnvironment(repoRoot, baseRevision);

    const passing = runTrustedEntrypoint(entrypoint, repoRoot, environment);
    expect(passing.status, passing.stderr).toBe(0);
    expect(passing.stdout, `stderr: ${passing.stderr}`).toContain(
      "Base-trusted createRequire allowlist ratchet passed.",
    );

    writeFixture(
      repoRoot,
      "src/lib/dynamic-alias-boundary.ts",
      [
        'const moduleObject = await import("node:module");',
        'const { "createRequire": load } = moduleObject;',
        "export const requireFromHere = load(import.meta.url);",
      ].join("\n"),
    );
    writeFixture(
      repoRoot,
      "src/lib/namespace-alias-boundary.ts",
      [
        'import * as nodeModule from "node:module";',
        "const moduleObject = nodeModule;",
        'const { "createRequire": load } = moduleObject;',
        "export const requireFromHere = load(import.meta.url);",
      ].join("\n"),
    );
    const failing = runTrustedEntrypoint(entrypoint, repoRoot, environment);
    expect(failing.status).toBe(1);
    expect(failing.stderr).toContain(
      "Production TypeScript must not introduce createRequire boundaries",
    );
    expect(failing.stderr).toContain("- src/lib/dynamic-alias-boundary.ts");
    expect(failing.stderr).toContain("- src/lib/namespace-alias-boundary.ts");
    expect(failing.stderr).not.toContain("src/lib/fixture-property.ts");
  });

  it("accepts only a validated base revision from the pull-request event (#7056)", () => {
    expect(
      extractPullRequestBaseSha(JSON.stringify({ pull_request: { base: { sha: BASE_SHA } } })),
    ).toBe(BASE_SHA);
    expect(() => extractPullRequestBaseSha('{"pull_request":{"base":{"sha":"HEAD^"}}}')).toThrow(
      "pull-request event does not contain a valid base commit SHA",
    );
  });

  it("fetches one exact missing base revision in a shallow checkout (#7056)", () => {
    const root = temporaryRepo();
    const calls: Array<{ args: readonly string[]; timeoutMs: number | undefined }> = [];
    let available = false;
    const runner: GitRunner = (args, timeoutMs) => {
      calls.push({ args, timeoutMs });
      switch (args[0]) {
        case "cat-file":
          return { status: available ? 0 : 128, stderr: "", stdout: "" };
        case "fetch":
          available = true;
          return { status: 0, stderr: "", stdout: "" };
        default:
          throw new Error(`unexpected git arguments: ${args.join(" ")}`);
      }
    };

    expect(resolveBaseRevision(root, pullRequestEnvironment(root), runner)).toBe(BASE_SHA);
    expect(calls).toEqual([
      { args: ["cat-file", "-e", `${BASE_SHA}^{commit}`], timeoutMs: undefined },
      {
        args: ["fetch", "--no-tags", "--depth=1", "origin", BASE_SHA],
        timeoutMs: 30_000,
      },
      { args: ["cat-file", "-e", `${BASE_SHA}^{commit}`], timeoutMs: undefined },
    ]);
  });

  it("fails closed when an exact shallow-base fetch cannot complete (#7056)", () => {
    const root = temporaryRepo();
    const runner: GitRunner = (args) => ({
      status: args[0] === "fetch" ? 128 : 1,
      stderr: "unavailable",
      stdout: "",
    });
    expect(() => resolveBaseRevision(root, pullRequestEnvironment(root), runner)).toThrow(
      `could not fetch the pull-request base commit ${BASE_SHA}`,
    );
  });
});

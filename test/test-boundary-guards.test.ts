// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  findCompiledInternalViolations,
  findFastProjectTransitiveViolations,
  isFastProjectTestPath,
  isScannedTestPath,
} from "../scripts/checks/no-test-dist-imports";
import { findProjectOverlaps, parseProjectListing } from "../scripts/checks/vitest-project-overlap";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const SOURCE_RUNTIME = path.join(REPO_ROOT, "test", "helpers", "onboard-script-mocks.cjs");

function withImportGraphFixture<T>(
  files: Readonly<Record<string, string>>,
  inspect: (root: string) => T,
): T {
  const root = fs.mkdtempSync(path.join(REPO_ROOT, "test", ".compiled-import-graph-"));
  try {
    for (const [file, source] of Object.entries(files)) {
      const absolutePath = path.join(root, file);
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.writeFileSync(absolutePath, source);
    }
    return inspect(root);
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
}

function fixtureRepoPath(root: string, file: string): string {
  return path.relative(REPO_ROOT, path.join(root, file)).split(path.sep).join("/");
}

describe("compiled-test import boundary", () => {
  it("detects every supported compiled-internal reference shape", () => {
    const specifier = (target: string) => ["..", "dist", target].join("/");
    const fixture = [
      'import path from "node:path";',
      `import value from ${JSON.stringify(specifier("lib/value.js"))};`,
      `export { value } from ${JSON.stringify(specifier("commands/value.js"))};`,
      `require(${JSON.stringify(specifier("lib/required.js"))});`,
      `require.resolve(${JSON.stringify(specifier("nemoclaw.js"))});`,
      `import(${JSON.stringify(specifier("commands/dynamic.js"))});`,
      `path.join(repoRoot, ${JSON.stringify("dist")}, ${JSON.stringify("lib")}, "joined.js");`,
    ].join("\n");

    const violations = findCompiledInternalViolations("test/example.test.ts", fixture);

    expect(violations).toHaveLength(6);
    expect(violations.map(({ detail }) => detail)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("imports compiled CLI internals"),
        "constructs a path into dist/lib",
      ]),
    );
  });

  it("detects createRequire aliases, constants, type imports, and generated scripts", () => {
    const specifier = (target: string) => ["..", "dist", target].join("/");
    const embeddedScript = [
      "const script = String.raw`",
      `const dist = (...parts) => path.join(root, ${JSON.stringify("dist")}, ${JSON.stringify("lib")}, ...parts);`,
      'require(dist("runner.js"));',
      "`;",
    ].join("\n");
    const fixture = [
      'import { createRequire } from "node:module";',
      "const load = createRequire(import.meta.url);",
      `load(${JSON.stringify(specifier("lib/aliased.js"))});`,
      `const resolvedTarget = ${JSON.stringify(specifier("commands/resolved.js"))};`,
      "load.resolve(resolvedTarget);",
      `type Loaded = typeof import(${JSON.stringify(specifier("lib/typed.js"))});`,
      `const generated = path.resolve(${JSON.stringify("dist/lib/generated.js")});`,
      embeddedScript,
    ].join("\n");

    const violations = findCompiledInternalViolations("test/example.test.ts", fixture);

    expect(violations).toHaveLength(5);
    expect(violations.map(({ detail }) => detail)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("aliased.js"),
        expect.stringContaining("resolved.js"),
        expect.stringContaining("typed.js"),
        "constructs a path into dist/lib",
      ]),
    );
    expect(
      violations.filter(({ detail }) => detail === "constructs a path into dist/lib"),
    ).toHaveLength(2);
  });

  it("resolves aliases and constants in their lexical scope", () => {
    const fixture = [
      'const target = "../dist/lib/real.js";',
      "require(target);",
      "{",
      '  const target = "../src/lib/safe.js";',
      "  require(target);",
      "}",
      "const load = createRequire(import.meta.url);",
      "function useInjectedLoader(load: (value: string) => unknown) {",
      '  load("../dist/lib/shadowed.js");',
      "}",
    ].join("\n");

    const violations = findCompiledInternalViolations("test/example.test.ts", fixture);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.detail).toContain("real.js");
  });

  it("ignores inert text and shadowed built-in helpers", () => {
    const fixture = [
      '// require("../dist/lib/comment.js");',
      "const generatedExample = 'require(\"../dist/lib/inert.js\");';",
      "function useSafeHelpers(require: (value: string) => unknown, path: unknown) {",
      '  require("../dist/commands/shadowed.js");',
      '  path.resolve("dist", "lib", "shadowed.js");',
      "}",
      'require("../src/lib/source.js");',
    ].join("\n");

    expect(findCompiledInternalViolations("test/example.test.ts", fixture)).toEqual([]);
  });

  it("detects CommonJS and TypeScript path aliases", () => {
    const fixture = [
      'const commonJsPath = require("node:path");',
      'commonJsPath.join(root, "dist", "lib", "commonjs.js");',
      'import importEqualsPath = require("node:path");',
      'importEqualsPath.resolve(root, "dist", "commands", "import-equals.js");',
    ].join("\n");

    const violations = findCompiledInternalViolations("test/example.test.ts", fixture);

    expect(violations).toHaveLength(2);
    expect(violations.map(({ detail }) => detail)).toEqual(
      expect.arrayContaining([
        "constructs a path into dist/lib",
        "constructs a path into dist/commands",
      ]),
    );
  });

  it("detects createRequire destructured from CommonJS module imports", () => {
    const fixture = [
      'const { createRequire: makeRequire } = require("node:module");',
      "const load = makeRequire(import.meta.url);",
      'load("../dist/lib/commonjs-create-require.js");',
    ].join("\n");

    const violations = findCompiledInternalViolations("test/example.test.ts", fixture);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.detail).toContain("commonjs-create-require.js");
  });

  it("detects direct and namespace-qualified createRequire calls", () => {
    const fixture = [
      'import { createRequire } from "node:module";',
      'import * as nodeModule from "node:module";',
      'createRequire(import.meta.url)("../dist/lib/direct-create-require.js");',
      'nodeModule.createRequire(import.meta.url)("../dist/commands/namespace-create-require.js");',
      'const commonJsModule = require("node:module");',
      'commonJsModule.createRequire(import.meta.url)("../dist/lib/commonjs-namespace.js");',
    ].join("\n");

    const violations = findCompiledInternalViolations("test/example.test.ts", fixture);

    expect(violations).toHaveLength(3);
    expect(violations.map(({ detail }) => detail)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("direct-create-require.js"),
        expect.stringContaining("namespace-create-require.js"),
        expect.stringContaining("commonjs-namespace.js"),
      ]),
    );
  });

  it("unwraps JavaScript and TypeScript expression wrappers around static loaders", () => {
    const fixture = [
      'require(("../dist/lib/parenthesized.js"));',
      'import(("../dist/commands/dynamic.js"));',
      'require.resolve(("../dist/lib/resolved.js"));',
      'const asserted = "../dist/lib/asserted.js" as const;',
      "require(asserted);",
      'const satisfied = "../dist/commands/satisfied.js" satisfies string;',
      "require(satisfied);",
    ].join("\n");

    const violations = findCompiledInternalViolations("test/example.test.ts", fixture);

    expect(violations).toHaveLength(5);
    expect(violations.map(({ detail }) => detail)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("parenthesized.js"),
        expect.stringContaining("dynamic.js"),
        expect.stringContaining("resolved.js"),
        expect.stringContaining("asserted.js"),
        expect.stringContaining("satisfied.js"),
      ]),
    );
  });

  it("detects compiled internals in TypeScript import-equals declarations", () => {
    const fixture = [
      'import compiled = require("../dist/lib/import-equals.js");',
      'export import exported = require("../dist/commands/export-import-equals.js");',
    ].join("\n");

    const violations = findCompiledInternalViolations("test/example.test.ts", fixture);

    expect(violations).toHaveLength(2);
    expect(violations.map(({ detail }) => detail)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("import-equals.js"),
        expect.stringContaining("export-import-equals.js"),
      ]),
    );
  });

  it("preserves static String.raw substitutions while scanning generated scripts", () => {
    const fixture = [
      "const script = String.raw`",
      'require(${JSON.stringify("../dist/lib/generated-substitution.js")});',
      "`;",
    ].join("\n");

    const violations = findCompiledInternalViolations("test/example.test.ts", fixture);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.detail).toContain("generated-substitution.js");
  });

  it("detects aliased and inline CommonJS createRequire factories", () => {
    const fixture = [
      'import * as nodeModule from "node:module";',
      "const makeRequire = nodeModule.createRequire;",
      "const load = makeRequire(import.meta.url);",
      'load("../dist/lib/member-alias.js");',
      'require("node:module").createRequire(import.meta.url)("../dist/commands/inline.js");',
      "const { createRequire: destructuredFactory } = nodeModule;",
      "const destructuredLoad = destructuredFactory(import.meta.url);",
      'destructuredLoad("../dist/lib/destructured-member.js");',
    ].join("\n");

    const violations = findCompiledInternalViolations("test/example.test.ts", fixture);

    expect(violations).toHaveLength(3);
    expect(violations.map(({ detail }) => detail)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("member-alias.js"),
        expect.stringContaining("inline.js"),
        expect.stringContaining("destructured-member.js"),
      ]),
    );
  });

  it("detects named, destructured, and inline CommonJS path builders", () => {
    const fixture = [
      'import { join as namedJoin } from "node:path";',
      'require(namedJoin(repoRoot, "dist", "lib", "named.js"));',
      'const { resolve: destructuredResolve } = require("node:path");',
      'require(destructuredResolve(repoRoot, "dist", "commands", "destructured.js"));',
      'require(require("node:path").join(repoRoot, "dist", "lib", "inline.js"));',
    ].join("\n");

    const violations = findCompiledInternalViolations("test/example.test.ts", fixture);

    expect(violations).toHaveLength(3);
    expect(violations.map(({ detail }) => detail)).toEqual(
      expect.arrayContaining([
        "constructs a path into dist/lib",
        "constructs a path into dist/commands",
      ]),
    );
  });

  it("pre-resolves constants used by earlier closures", () => {
    const fixture = [
      "function loadCompiledModule() {",
      "  require(TARGET);",
      "}",
      'const TARGET = "../dist/lib/later.js";',
    ].join("\n");

    const violations = findCompiledInternalViolations("test/example.test.ts", fixture);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.detail).toContain("later.js");
  });

  it("keeps switch bindings inside the shared case scope", () => {
    const fixture = [
      "switch (mode) {",
      "  case 0:",
      '    require("../dist/lib/shadowed-before-declaration.js");',
      "    break;",
      "  case 1:",
      "    const require = injectedLoader;",
      "    break;",
      "}",
      'require("../dist/lib/outer.js");',
    ].join("\n");

    const violations = findCompiledInternalViolations("test/example.test.ts", fixture);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.detail).toContain("outer.js");
  });

  it("evaluates switch discriminants outside the shared case scope", () => {
    const fixture = [
      'switch (require("../dist/lib/discriminant.js")) {',
      "  case 0:",
      "    const require = injectedLoader;",
      "    break;",
      "}",
    ].join("\n");

    const violations = findCompiledInternalViolations("test/example.test.ts", fixture);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.detail).toContain("discriminant.js");
  });

  it("evaluates computed method names outside the method parameter scope", () => {
    const fixture = [
      "const methods = {",
      '  [require("../dist/lib/computed-name.js")](require: unknown) {},',
      "};",
    ].join("\n");

    const violations = findCompiledInternalViolations("test/example.test.ts", fixture);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.detail).toContain("computed-name.js");
  });

  it("evaluates method decorators outside the method parameter scope", () => {
    const fixture = [
      "class Decorated {",
      '  @register(require("../dist/lib/decorator.js"))',
      "  run(require: unknown) {}",
      "}",
    ].join("\n");

    const violations = findCompiledInternalViolations("test/example.test.ts", fixture);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.detail).toContain("decorator.js");
  });

  it("evaluates parameter decorators outside the method parameter scope", () => {
    const fixture = [
      "class Decorated {",
      '  run(@register(require("../dist/lib/parameter-decorator.js")) value: unknown, require: unknown) {}',
      "}",
    ].join("\n");

    const violations = findCompiledInternalViolations("test/example.test.ts", fixture);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.detail).toContain("parameter-decorator.js");
  });

  it("normalizes static path traversal before classifying compiled targets", () => {
    const fixture = [
      'import path from "node:path";',
      'path.join(root, "dist", "lib", "..", "src", "safe.js");',
      'path.resolve(root, "dist", "commands", "..", "src", "safe.js");',
      'path.join(root, "dist", "lib", "nested", "..", "compiled.js");',
    ].join("\n");

    const violations = findCompiledInternalViolations("test/example.test.ts", fixture);

    expect(violations).toEqual([
      {
        file: "test/example.test.ts",
        line: 4,
        detail: "constructs a path into dist/lib",
      },
    ]);
  });

  it("does not hoist namespace or class-static var bindings into the file", () => {
    const fixture = [
      "class Example {",
      "  static { var require = injectedLoader; void require; }",
      "}",
      "namespace Fixtures {",
      "  var path = injectedPath;",
      "}",
      'require("../dist/lib/outer.js");',
      'path.join(root, "dist", "commands", "outer.js");',
    ].join("\n");

    const violations = findCompiledInternalViolations("test/example.test.ts", fixture);

    expect(violations).toHaveLength(2);
  });

  it("treats TypeScript namespace names as lexical bindings", () => {
    const fixture = [
      "namespace path {",
      '  export function resolve(..._parts: string[]) { return "safe"; }',
      "}",
      'path.resolve("dist", "lib", "namespace-member.js");',
    ].join("\n");

    expect(findCompiledInternalViolations("test/example.test.ts", fixture)).toEqual([]);
  });

  it("keeps named class-expression bindings inside the class", () => {
    const fixture = [
      "const Example = class path {",
      '  static resolve(...parts: string[]) { return parts.join("/"); }',
      '  static built = path.resolve("dist", "lib", "inner-name.js");',
      "};",
      'path.resolve("dist", "commands", "outer.js");',
    ].join("\n");

    const violations = findCompiledInternalViolations("test/example.test.ts", fixture);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.detail).toBe("constructs a path into dist/commands");
  });

  it("scans ordinary tests while preserving explicit package, live, and fixture lanes", () => {
    expect(isScannedTestPath("src/lib/example.test.ts")).toBe(true);
    expect(isScannedTestPath("test/example.test.ts")).toBe(true);
    expect(isScannedTestPath("test/package-contract/example.test.ts")).toBe(false);
    expect(isScannedTestPath("test/e2e/example.test.ts")).toBe(false);
    expect(isScannedTestPath("test/dist-sourcemaps.test.ts")).toBe(false);
  });
});

describe("fast-project transitive import boundary", () => {
  it("uses exactly the test:fast Vitest project paths as graph roots (#6692)", () => {
    expect(
      [
        "src/lib/example.test.ts",
        "src/lib/coverage/example.test.ts",
        "src/lib/dist/example.test.ts",
        "src/lib/.claude/example.test.ts",
        "src/.claude/example.test.ts",
        "nemoclaw/src/blueprint/example.test.ts",
        "nemoclaw/src/.claude/example.test.ts",
        "test/e2e/support/example.test.ts",
        "test/example.test.ts",
        "test/e2e/live/example.test.ts",
        "test/package-contract/example.test.ts",
      ].map(isFastProjectTestPath),
    ).toEqual([true, true, true, false, false, true, true, true, false, false, false]);
  });

  it("reports a shortest chain through static import, export, dynamic import, and require edges (#6692)", () => {
    withImportGraphFixture(
      {
        "dynamic.ts": 'void import("./required.js");\n',
        "entry.test.ts": 'import "./exporter.js";\n',
        "exporter.ts": 'export * from "./dynamic.js";\n',
        "helper.ts": 'import "../../dist/lib/onboard.js";\n',
        "required.ts": 'const loaded = require("./helper.js");\nexport { loaded };\n',
      },
      (root) => {
        expect(findFastProjectTransitiveViolations([path.join(root, "entry.test.ts")])).toEqual([
          {
            chain: [
              fixtureRepoPath(root, "entry.test.ts"),
              fixtureRepoPath(root, "exporter.ts"),
              fixtureRepoPath(root, "dynamic.ts"),
              fixtureRepoPath(root, "required.ts"),
              fixtureRepoPath(root, "helper.ts"),
            ],
            detail: 'imports compiled CLI internals from "../../dist/lib/onboard.js"',
            file: fixtureRepoPath(root, "helper.ts"),
            line: 1,
          },
        ]);
      },
    );
  });

  it("terminates cyclic createRequire graphs with one deterministic violation (#6692)", () => {
    withImportGraphFixture(
      {
        "a.ts": 'import "./b.js";\n',
        "b.ts": [
          'import { createRequire } from "node:module";',
          "const load = createRequire(import.meta.url);",
          'load("./c.js");',
        ].join("\n"),
        "c.ts": ['import "./a.js";', 'import "../../dist/commands/cycle.js";'].join("\n"),
        "entry.test.ts": 'import "./a.js";\n',
      },
      (root) => {
        expect(findFastProjectTransitiveViolations([path.join(root, "entry.test.ts")])).toEqual([
          {
            chain: [
              fixtureRepoPath(root, "entry.test.ts"),
              fixtureRepoPath(root, "a.ts"),
              fixtureRepoPath(root, "b.ts"),
              fixtureRepoPath(root, "c.ts"),
            ],
            detail: 'imports compiled CLI internals from "../../dist/commands/cycle.js"',
            file: fixtureRepoPath(root, "c.ts"),
            line: 2,
          },
        ]);
      },
    );
  });

  it("reports the shortest route when a longer import chain is discovered first (#6692)", () => {
    withImportGraphFixture(
      {
        "entry.test.ts": ['import "./long-a.js";', 'import "./short.js";'].join("\n"),
        "long-a.ts": 'import "./long-b.js";\n',
        "long-b.ts": 'import "./target.js";\n',
        "short.ts": 'import "./target.js";\n',
        "target.ts": 'import "../../dist/lib/compiled.js";\n',
      },
      (root) => {
        expect(findFastProjectTransitiveViolations([path.join(root, "entry.test.ts")])).toEqual([
          {
            chain: [
              fixtureRepoPath(root, "entry.test.ts"),
              fixtureRepoPath(root, "short.ts"),
              fixtureRepoPath(root, "target.ts"),
            ],
            detail: 'imports compiled CLI internals from "../../dist/lib/compiled.js"',
            file: fixtureRepoPath(root, "target.ts"),
            line: 1,
          },
        ]);
      },
    );
  });

  it("rejects an alias whose resolved target is a compiled CLI module (#6692)", () => {
    withImportGraphFixture(
      {
        "entry.test.ts": 'import "./source-alias.js";\n',
      },
      (root) => {
        const distRoot = path.join(REPO_ROOT, "dist");
        const compiledRoot = path.join(distRoot, "lib");
        const parentsToRemove = [compiledRoot, distRoot].filter((dir) => !fs.existsSync(dir));
        fs.mkdirSync(compiledRoot, { recursive: true });
        const compiledFixtureRoot = fs.mkdtempSync(
          path.join(compiledRoot, ".compiled-import-alias-"),
        );
        const compiledTarget = path.join(compiledFixtureRoot, "compiled.ts");

        try {
          fs.writeFileSync(compiledTarget, "export const compiled = true;\n");
          fs.symlinkSync(compiledTarget, path.join(root, "source-alias.ts"));
          const compiledRepoPath = path
            .relative(REPO_ROOT, compiledTarget)
            .split(path.sep)
            .join("/");
          expect(findFastProjectTransitiveViolations([path.join(root, "entry.test.ts")])).toEqual([
            {
              chain: [fixtureRepoPath(root, "entry.test.ts")],
              detail: `imports compiled CLI internals from "./source-alias.js" (resolves to ${compiledRepoPath})`,
              file: fixtureRepoPath(root, "entry.test.ts"),
              line: 1,
            },
          ]);
        } finally {
          fs.rmSync(compiledFixtureRoot, { force: true, recursive: true });
          for (const parent of parentsToRemove) {
            try {
              fs.rmdirSync(parent);
            } catch {
              // Another test or build may now own the generated parent.
            }
          }
        }
      },
    );
  });

  it("reports compiled loads inside generated scripts reached through fast helpers (#6692)", () => {
    withImportGraphFixture(
      {
        "entry.test.ts": 'import "./helper.js";\n',
        "helper.ts": 'export const script = String.raw`require("../../dist/lib/embedded.js");`;\n',
      },
      (root) => {
        expect(findFastProjectTransitiveViolations([path.join(root, "entry.test.ts")])).toEqual([
          {
            chain: [fixtureRepoPath(root, "entry.test.ts"), fixtureRepoPath(root, "helper.ts")],
            detail: 'imports compiled CLI internals from "../../dist/lib/embedded.js"',
            file: fixtureRepoPath(root, "helper.ts"),
            line: 1,
          },
        ]);
      },
    );
  });

  it("ignores external packages whose own layout contains dist/lib (#6692)", () => {
    withImportGraphFixture(
      {
        "entry.test.ts": 'import type { External } from "boundary-external";\n',
        "node_modules/boundary-external/dist/lib/index.d.ts": "export type External = string;\n",
        "node_modules/boundary-external/package.json": JSON.stringify({
          name: "boundary-external",
          types: "dist/lib/index.d.ts",
          version: "1.0.0",
        }),
      },
      (root) => {
        expect(findFastProjectTransitiveViolations([path.join(root, "entry.test.ts")])).toEqual([]);
      },
    );
  });

  it("ignores unreachable compiled imports and ordinary runtime dist paths (#6692)", () => {
    withImportGraphFixture(
      {
        "entry.test.ts": 'import "./safe.js";\n',
        "orphan.ts": 'import "../../dist/lib/orphan.js";\n',
        "safe.ts": [
          'import path from "node:path";',
          'export const runtimePath = path.join(root, "dist", "lib", "runtime.js");',
        ].join("\n"),
      },
      (root) => {
        expect(findFastProjectTransitiveViolations([path.join(root, "entry.test.ts")])).toEqual([]);
      },
    );
  });
});

describe("Vitest project membership boundary", () => {
  it("accepts disjoint listings and reports duplicate membership", () => {
    const disjoint = parseProjectListing("[cli] src/a.test.ts\n[integration] test/b.test.ts\n");
    expect(findProjectOverlaps(disjoint.projectsByFile)).toEqual([]);

    const overlapping = parseProjectListing(
      "[cli] src/a.test.ts\n[integration] test/b.test.ts\n[package-contract] src/a.test.ts\n",
    );
    expect(findProjectOverlaps(overlapping.projectsByFile)).toEqual([
      ["src/a.test.ts", new Set(["cli", "package-contract"])],
    ]);
  });

  it("fails closed when Vitest listing output changes shape", () => {
    expect(() => parseProjectListing("unexpected output")).toThrow(
      "Could not parse Vitest project listing line",
    );
  });
});

describe("CommonJS source runtime", () => {
  it("rewrites relative JavaScript requests only within the source tree", () => {
    const sourceFixture = fs.mkdtempSync(path.join(REPO_ROOT, "src", ".source-loader-test-"));
    const outsideFixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-source-loader-test-"));

    try {
      for (const directory of [sourceFixture, outsideFixture]) {
        fs.writeFileSync(path.join(directory, "value.ts"), 'export const marker = "source";\n');
        fs.writeFileSync(
          path.join(directory, "parent.cjs"),
          'process.stdout.write(require("./value.js").marker);\n',
        );
      }

      const run = (directory: string) =>
        spawnSync(
          process.execPath,
          ["--require", SOURCE_RUNTIME, path.join(directory, "parent.cjs")],
          {
            cwd: REPO_ROOT,
            encoding: "utf8",
            env: { ...process.env, NODE_OPTIONS: "" },
          },
        );

      const inside = run(sourceFixture);
      expect(inside.status, inside.stderr).toBe(0);
      expect(inside.stdout).toBe("source");

      const outside = run(outsideFixture);
      expect(outside.status).not.toBe(0);
      expect(outside.stderr).toContain("Cannot find module './value.js'");
    } finally {
      fs.rmSync(sourceFixture, { force: true, recursive: true });
      fs.rmSync(outsideFixture, { force: true, recursive: true });
    }
  });
});

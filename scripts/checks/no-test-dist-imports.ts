// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

export type Violation = { file: string; line: number; detail: string };

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SKIP_DIRS = new Set([".git", "coverage", "dist", "node_modules"]);
// These tests intentionally construct fake dist/lib trees; they do not load
// repository build output. The self-audit below prevents this list growing or
// retaining an exemption after the fixture no longer needs one.
const FIXTURE_EXCLUSIONS = new Set([
  "test/dist-sourcemaps.test.ts",
  "test/install-preflight.test.ts",
  "test/stale-dist-check.test.ts",
]);
const EXCLUDED_PREFIXES = [
  // Live/branch E2E validates installed artifacts rather than unit-test imports.
  "test/e2e/",
  "test/e2e-scenario/live/",
  // This is the sole non-live lane allowed to import compiled package artifacts.
  "test/package-contract/",
];

function repoPath(absolutePath: string): string {
  return path.relative(REPO_ROOT, absolutePath).split(path.sep).join("/");
}

export function isScannedTestPath(relativePath: string): boolean {
  if (FIXTURE_EXCLUSIONS.has(relativePath)) return false;
  if (EXCLUDED_PREFIXES.some((prefix) => relativePath.startsWith(prefix))) return false;
  if (relativePath.startsWith("src/")) return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(relativePath);
  return relativePath.startsWith("test/") && /\.[cm]?[jt]sx?$/.test(relativePath);
}

function isScannedTestFile(absolutePath: string): boolean {
  return isScannedTestPath(repoPath(absolutePath));
}

function* walk(directory: string): Generator<string> {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory)) {
    if (SKIP_DIRS.has(entry)) continue;
    const absolutePath = path.join(directory, entry);
    const stats = statSync(absolutePath);
    if (stats.isDirectory()) yield* walk(absolutePath);
    else if (stats.isFile() && isScannedTestFile(absolutePath)) yield absolutePath;
  }
}

function isCompiledInternalSpecifier(specifier: string): boolean {
  const normalized = specifier.replaceAll("\\", "/");
  return (
    /(^|\/)dist\/(?:lib|commands)(?:\/|$)/.test(normalized) ||
    /(^|\/)dist\/nemoclaw(?:\.js)?$/.test(normalized)
  );
}

function staticString(
  node: ts.Node | undefined,
  constants: ReadonlyMap<string, string>,
): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isIdentifier(node)) return constants.get(node.text);
  return undefined;
}

function compiledPathBuilderTarget(
  node: ts.CallExpression,
  constants: ReadonlyMap<string, string>,
): string | undefined {
  if (
    !ts.isPropertyAccessExpression(node.expression) ||
    !ts.isIdentifier(node.expression.expression) ||
    node.expression.expression.text !== "path" ||
    !["join", "resolve"].includes(node.expression.name.text)
  ) {
    return undefined;
  }

  const parts = node.arguments.flatMap((argument) => {
    const value = staticString(argument, constants);
    return value ? value.replaceAll("\\", "/").split("/") : [];
  });
  const distIndex = parts.indexOf("dist");
  const compiledTarget = distIndex >= 0 ? parts[distIndex + 1] : undefined;
  if (compiledTarget === "lib" || compiledTarget === "commands") return `dist/${compiledTarget}`;
  if (compiledTarget === "nemoclaw.js") return "dist/nemoclaw.js";
  return undefined;
}

function isStringRawTag(node: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "String" &&
    node.name.text === "raw"
  );
}

function templateSource(node: ts.TemplateLiteral): string {
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return node.templateSpans.reduce(
    (source, span) => `${source}undefined${span.literal.text}`,
    node.head.text,
  );
}

export function findCompiledInternalViolations(file: string, source: string): Violation[] {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const violations: Violation[] = [];

  function scan(scannedFile: ts.SourceFile, lineOffset = 0, scanTemplates = true): void {
    const constants = new Map<string, string>();
    const requireAliases = new Set(["require"]);

    function collectBindings(node: ts.Node): void {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const value = staticString(node.initializer, constants);
        if (value !== undefined) constants.set(node.name.text, value);
        if (
          ts.isCallExpression(node.initializer) &&
          ts.isIdentifier(node.initializer.expression) &&
          node.initializer.expression.text === "createRequire"
        ) {
          requireAliases.add(node.name.text);
        }
      }
      ts.forEachChild(node, collectBindings);
    }

    function add(node: ts.Node, detail: string): void {
      const position = scannedFile.getLineAndCharacterOfPosition(node.getStart(scannedFile));
      violations.push({ file, line: position.line + lineOffset + 1, detail });
    }

    function checkSpecifier(node: ts.Node, specifier: string): void {
      if (isCompiledInternalSpecifier(specifier)) {
        add(node, `imports compiled CLI internals from ${JSON.stringify(specifier)}`);
      }
    }

    function visit(node: ts.Node): void {
      if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
        checkSpecifier(node.moduleSpecifier, node.moduleSpecifier.text);
      } else if (
        ts.isExportDeclaration(node) &&
        node.moduleSpecifier &&
        ts.isStringLiteralLike(node.moduleSpecifier)
      ) {
        checkSpecifier(node.moduleSpecifier, node.moduleSpecifier.text);
      } else if (ts.isImportTypeNode(node)) {
        const argument = node.argument;
        if (ts.isLiteralTypeNode(argument) && ts.isStringLiteralLike(argument.literal)) {
          checkSpecifier(argument.literal, argument.literal.text);
        }
      } else if (ts.isCallExpression(node)) {
        const isRequire =
          ts.isIdentifier(node.expression) && requireAliases.has(node.expression.text);
        const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
        const isRequireResolve =
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          requireAliases.has(node.expression.expression.text) &&
          node.expression.name.text === "resolve";
        const firstArgument = node.arguments[0];
        const specifier = staticString(firstArgument, constants);
        if ((isRequire || isDynamicImport || isRequireResolve) && firstArgument && specifier) {
          checkSpecifier(firstArgument, specifier);
        }

        const pathTarget = compiledPathBuilderTarget(node, constants);
        if (pathTarget === "dist/nemoclaw.js") {
          add(node, "constructs a path to dist/nemoclaw.js");
        } else if (pathTarget) {
          add(node, `constructs a path into ${pathTarget}`);
        }
      } else if (scanTemplates && ts.isTaggedTemplateExpression(node) && isStringRawTag(node.tag)) {
        const embeddedSource = ts.createSourceFile(
          `${file}.embedded.js`,
          templateSource(node.template),
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.JS,
        );
        const templateLine = scannedFile.getLineAndCharacterOfPosition(
          node.template.getStart(scannedFile),
        ).line;
        scan(embeddedSource, lineOffset + templateLine, false);
      }
      ts.forEachChild(node, visit);
    }

    collectBindings(scannedFile);
    visit(scannedFile);
  }

  scan(sourceFile);
  for (const match of source.matchAll(/require\([^\n)]*(?:\.\/|\.\.\/)dist\/(?:lib|commands)\//g)) {
    const position = sourceFile.getLineAndCharacterOfPosition(match.index);
    violations.push({
      file,
      line: position.line + 1,
      detail: "embeds a compiled-internal require in generated test code",
    });
  }
  return violations.filter(
    (violation, index, all) =>
      all.findIndex(
        (candidate) => candidate.file === violation.file && candidate.line === violation.line,
      ) === index,
  );
}

function findViolations(absolutePath: string): Violation[] {
  return findCompiledInternalViolations(repoPath(absolutePath), readFileSync(absolutePath, "utf8"));
}

function main(): void {
  const staleFixtureExclusions = [...FIXTURE_EXCLUSIONS].filter((relativePath) => {
    const absolutePath = path.join(REPO_ROOT, relativePath);
    return !existsSync(absolutePath) || findViolations(absolutePath).length === 0;
  });

  if (staleFixtureExclusions.length > 0) {
    console.error("Fixture exclusions must exist and still construct a compiled-internal path:");
    for (const relativePath of staleFixtureExclusions) console.error(`  ${relativePath}`);
    process.exit(1);
  }

  const violations = [
    ...walk(path.join(REPO_ROOT, "src")),
    ...walk(path.join(REPO_ROOT, "test")),
  ].flatMap(findViolations);

  if (violations.length > 0) {
    console.error(
      "Compiled CLI internals may only be imported by the package-contract test project:",
    );
    for (const violation of violations) {
      console.error(`  ${violation.file}:${violation.line} ${violation.detail}`);
    }
    console.error(
      "Import src/ instead, or move a genuine compiled-package contract under test/package-contract/.",
    );
    process.exit(1);
  }

  console.log("Test imports respect the source/package boundary.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}

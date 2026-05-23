// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import ts from "typescript";

type MatchKind = "call" | "assign";

type Binding = {
  moduleSpecifier: string;
  importedName: string;
};

type Match = {
  filePath: string;
  line: number;
  column: number;
  kind: MatchKind;
  name: string;
  expression: string;
  moduleSpecifier: string | null;
  runnerBound: boolean;
  arg0Kind: string | null;
  commandHead: string | null;
  snippet: string;
};

type Options = {
  rootDir: string;
  roots: string[];
  names: Set<string>;
  excludeTests: boolean;
  groupByCommand: boolean;
  markdown: boolean;
  json: boolean;
};

type CommandSummary = {
  command: string;
  calls: number;
  helpers: string[];
  files: number;
  examples: string[];
};

const DEFAULT_NAMES = Object.freeze([
  "run",
  "runInteractive",
  "runShell",
  "runInteractiveShell",
  "runCapture",
  "runFile",
  "runCommand",
  "execFileSync",
  "execFile",
  "execSync",
  "exec",
  "spawnSync",
  "spawn",
  "execa",
  "execaSync",
  "execaCommand",
  "execaCommandSync",
]);
const DEFAULT_ROOTS = Object.freeze(["src", "test", "scripts"]);
const EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".cjs", ".mjs"]);
const EXTERNAL_ONLY_NAMES = new Set([
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "spawn",
  "spawnSync",
  "execa",
  "execaSync",
  "execaCommand",
  "execaCommandSync",
]);
const IGNORED_DIRS = new Set([
  ".git",
  ".idea",
  ".next",
  ".turbo",
  ".venv",
  "coverage",
  "dist",
  "docs/_build",
  "node_modules",
]);

function parseArgs(argv: string[]): Options {
  const names = new Set(DEFAULT_NAMES);
  const roots: string[] = [];
  let rootDir = process.cwd();
  let excludeTests = true;
  let groupByCommand = true;
  let markdown = false;
  let json = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") {
      const value = argv[i + 1];
      if (!value) throw new Error("--root requires a directory");
      rootDir = path.resolve(value);
      i += 1;
      continue;
    }
    if (arg === "--names") {
      const value = argv[i + 1];
      if (!value) throw new Error("--names requires a comma-separated list");
      names.clear();
      for (const name of value
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)) {
        names.add(name);
      }
      i += 1;
      continue;
    }
    if (arg === "--exclude-tests") {
      excludeTests = true;
      continue;
    }
    if (arg === "--include-tests") {
      excludeTests = false;
      continue;
    }
    if (arg === "--group-by-command") {
      groupByCommand = true;
      continue;
    }
    if (arg === "--list-calls") {
      groupByCommand = false;
      continue;
    }
    if (arg === "--markdown") {
      markdown = true;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    roots.push(arg);
  }

  return {
    rootDir,
    roots: roots.length > 0 ? roots : [...DEFAULT_ROOTS],
    names,
    excludeTests,
    groupByCommand,
    markdown,
    json,
  };
}

function printHelp(): void {
  console.log(
    "Usage: tsx scripts/list-command-helper-uses.ts [--root <dir>] [--names run,runInteractive,...] [--include-tests] [--list-calls] [--markdown] [--json] [path ...]\n\n" +
      "Lists AST-level callsites and assignments for command helper names such as run(), runInteractive(), runCapture(), runShell(), execFileSync(), spawnSync(), and runCommand(). By default it excludes test files and groups results by inferred command head.\n\n" +
      "Examples:\n" +
      "  tsx scripts/list-command-helper-uses.ts\n" +
      "  tsx scripts/list-command-helper-uses.ts --markdown src\n" +
      "  tsx scripts/list-command-helper-uses.ts --include-tests --list-calls --json src test\n" +
      "  tsx scripts/list-command-helper-uses.ts --names run,runInteractive src test\n",
  );
}

function toPosixRelative(rootDir: string, filePath: string): string {
  return path.relative(rootDir, filePath).split(path.sep).join(path.posix.sep);
}

function isRunnerModule(specifier: string | null): boolean {
  if (!specifier) return false;
  const base = path.posix.basename(specifier).replace(/\.[^.]+$/, "");
  return base === "runner";
}

function isTestFile(rootDir: string, filePath: string): boolean {
  const rel = toPosixRelative(rootDir, filePath);
  return /(^|\/)(test|__tests__)\//.test(rel) || /\.test\.[^.]+$/.test(rel);
}

function collectFiles(rootDir: string, roots: readonly string[], excludeTests: boolean): string[] {
  const files = new Set<string>();

  function visit(absPath: string): void {
    if (!fs.existsSync(absPath)) return;
    const stat = fs.statSync(absPath);
    if (stat.isDirectory()) {
      const base = path.basename(absPath);
      const rel = toPosixRelative(rootDir, absPath);
      if (IGNORED_DIRS.has(base) || IGNORED_DIRS.has(rel)) return;
      for (const entry of fs.readdirSync(absPath)) {
        visit(path.join(absPath, entry));
      }
      return;
    }
    if (!stat.isFile() || !EXTENSIONS.has(path.extname(absPath))) return;
    const resolved = path.resolve(absPath);
    if (excludeTests && isTestFile(rootDir, resolved)) return;
    files.add(resolved);
  }

  for (const root of roots) {
    visit(path.resolve(rootDir, root));
  }

  return [...files].sort();
}

function getScriptKind(filePath: string): ts.ScriptKind {
  if (filePath.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (filePath.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (filePath.endsWith(".js") || filePath.endsWith(".cjs") || filePath.endsWith(".mjs")) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function collectBindings(sourceFile: ts.SourceFile): {
  named: Map<string, Binding>;
  namespaces: Map<string, string>;
} {
  const named = new Map<string, Binding>();
  const namespaces = new Map<string, string>();

  function addNamed(localName: string, importedName: string, moduleSpecifier: string): void {
    named.set(localName, { importedName, moduleSpecifier });
  }

  function addNamespace(localName: string, moduleSpecifier: string): void {
    namespaces.set(localName, moduleSpecifier);
  }

  function registerRequireBinding(name: ts.BindingName, moduleSpecifier: string): void {
    if (ts.isIdentifier(name)) {
      addNamespace(name.text, moduleSpecifier);
      return;
    }
    if (ts.isObjectBindingPattern(name)) {
      for (const element of name.elements) {
        if (!ts.isIdentifier(element.name)) continue;
        const importedName =
          element.propertyName && ts.isIdentifier(element.propertyName)
            ? element.propertyName.text
            : element.name.text;
        addNamed(element.name.text, importedName, moduleSpecifier);
      }
      return;
    }
  }

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const moduleSpecifier = node.moduleSpecifier.text;
      const clause = node.importClause;
      if (clause?.name) {
        addNamespace(clause.name.text, moduleSpecifier);
      }
      if (clause?.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) {
          addNamespace(clause.namedBindings.name.text, moduleSpecifier);
        } else {
          for (const element of clause.namedBindings.elements) {
            const importedName = element.propertyName?.text ?? element.name.text;
            addNamed(element.name.text, importedName, moduleSpecifier);
          }
        }
      }
    }

    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === "require" &&
      node.initializer.arguments.length === 1 &&
      ts.isStringLiteral(node.initializer.arguments[0])
    ) {
      registerRequireBinding(node.name, node.initializer.arguments[0].text);
    }

    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isIdentifier(node.initializer) &&
      namespaces.has(node.initializer.text) &&
      ts.isObjectBindingPattern(node.name)
    ) {
      registerRequireBinding(node.name, namespaces.get(node.initializer.text) || "");
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { named, namespaces };
}

function getCallTarget(
  expression: ts.LeftHandSideExpression,
  bindings: { named: Map<string, Binding>; namespaces: Map<string, string> },
): { name: string; expression: string; moduleSpecifier: string | null } | null {
  if (ts.isIdentifier(expression)) {
    return {
      name: expression.text,
      expression: expression.text,
      moduleSpecifier:
        bindings.named.get(expression.text)?.moduleSpecifier ||
        bindings.namespaces.get(expression.text) ||
        null,
    };
  }
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.name)) {
    const objectName = ts.isIdentifier(expression.expression) ? expression.expression.text : null;
    return {
      name: expression.name.text,
      expression: expression.getText(),
      moduleSpecifier: objectName ? bindings.namespaces.get(objectName) || null : null,
    };
  }
  return null;
}

function classifyArg0Kind(call: ts.CallExpression): string | null {
  const arg = call.arguments[0];
  if (!arg) return null;
  if (ts.isArrayLiteralExpression(arg)) return "array";
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return "string";
  if (ts.isTemplateExpression(arg)) return "template";
  if (ts.isIdentifier(arg)) return "identifier";
  if (ts.isObjectLiteralExpression(arg)) return "object";
  if (ts.isCallExpression(arg)) return "call";
  return ts.SyntaxKind[arg.kind] || "other";
}

function inferShellCommandHead(text: string): string | null {
  let rest = text.trim();
  if (!rest) return null;

  // Common shell prologue used in this repo before the real command.
  rest = rest.replace(/^set\s+-o\s+pipefail\s*;\s*/, "");

  // Skip leading env assignments like FOO=bar command ...
  while (true) {
    const match = rest.match(/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s;|&])+\s*/);
    if (!match) break;
    rest = rest.slice(match[0].length).trimStart();
  }

  // Skip lightweight wrappers that often precede the real command.
  if (rest.startsWith("command ")) {
    rest = rest.slice("command ".length).trimStart();
    while (rest.startsWith("-")) {
      const flag = rest.match(/^\S+\s*/);
      if (!flag) break;
      rest = rest.slice(flag[0].length).trimStart();
    }
  }
  rest = rest.replace(/^(?:nohup|env)\s+/, "");

  const head = rest.match(/^[A-Za-z0-9_./:-]+/);
  return head ? head[0] : null;
}

function inferCommandHead(call: ts.CallExpression): string | null {
  const arg = call.arguments[0];
  if (!arg) return null;

  if (ts.isArrayLiteralExpression(arg)) {
    const first = arg.elements[0];
    if (!first) return null;
    if (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) {
      return first.text;
    }
    return null;
  }

  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
    return inferShellCommandHead(arg.text);
  }

  return null;
}

function lineSnippet(sourceFile: ts.SourceFile, line: number): string {
  const start = sourceFile.getPositionOfLineAndCharacter(line, 0);
  const end =
    line + 1 < sourceFile.getLineAndCharacterOfPosition(sourceFile.end).line + 1
      ? sourceFile.getPositionOfLineAndCharacter(line + 1, 0)
      : sourceFile.end;
  return sourceFile.text.slice(start, end).trim();
}

function shouldKeepMatch(match: Match, options: Options): boolean {
  if (!options.names.has(match.name)) return false;
  if (EXTERNAL_ONLY_NAMES.has(match.name) && match.moduleSpecifier === null) return false;
  return true;
}

function scanFile(filePath: string, options: Options): Match[] {
  const text = fs.readFileSync(filePath, "utf-8");
  const sourceFile = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    getScriptKind(filePath),
  );
  const bindings = collectBindings(sourceFile);
  const matches: Match[] = [];

  function push(
    node: ts.Node,
    kind: MatchKind,
    name: string,
    expression: string,
    moduleSpecifier: string | null,
    arg0Kind: string | null,
    commandHead: string | null,
  ): void {
    const start = node.getStart(sourceFile);
    const pos = sourceFile.getLineAndCharacterOfPosition(start);
    const match: Match = {
      filePath,
      line: pos.line + 1,
      column: pos.character + 1,
      kind,
      name,
      expression,
      moduleSpecifier,
      runnerBound: isRunnerModule(moduleSpecifier),
      arg0Kind,
      commandHead,
      snippet: lineSnippet(sourceFile, pos.line),
    };
    if (shouldKeepMatch(match, options)) {
      matches.push(match);
    }
  }

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const target = getCallTarget(node.expression, bindings);
      if (target) {
        push(
          node,
          "call",
          target.name,
          target.expression,
          target.moduleSpecifier,
          classifyArg0Kind(node),
          inferCommandHead(node),
        );
      }
    }

    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      (ts.isIdentifier(node.left) || ts.isPropertyAccessExpression(node.left))
    ) {
      const target = getCallTarget(node.left as ts.LeftHandSideExpression, bindings);
      if (target) {
        push(
          node.left,
          "assign",
          target.name,
          target.expression,
          target.moduleSpecifier,
          null,
          null,
        );
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return matches;
}

function formatMatch(match: Match, rootDir: string): string {
  const rel = toPosixRelative(rootDir, match.filePath);
  const fields = [
    `${rel}:${String(match.line)}:${String(match.column)}`,
    match.kind.padEnd(6, " "),
    match.expression,
    `arg0=${match.arg0Kind ?? "-"}`,
    `runner=${match.runnerBound ? "yes" : "no"}`,
    `head=${match.commandHead ?? "-"}`,
  ];
  if (match.moduleSpecifier) {
    fields.push(`module=${match.moduleSpecifier}`);
  }
  return `${fields.join("  ")}\n  ${match.snippet}`;
}

function summarizeByCommand(matches: readonly Match[], rootDir: string): CommandSummary[] {
  const groups = new Map<string, Match[]>();
  for (const match of matches) {
    if (match.kind !== "call") continue;
    const key = match.commandHead ?? "<dynamic>";
    const existing = groups.get(key);
    if (existing) {
      existing.push(match);
    } else {
      groups.set(key, [match]);
    }
  }

  return [...groups.entries()]
    .map(([command, commandMatches]) => ({
      command,
      calls: commandMatches.length,
      helpers: [...new Set(commandMatches.map((match) => match.name))].sort(),
      files: new Set(commandMatches.map((match) => match.filePath)).size,
      examples: commandMatches
        .slice()
        .sort((a, b) => a.filePath.localeCompare(b.filePath) || a.line - b.line)
        .slice(0, 3)
        .map((match) => `${toPosixRelative(rootDir, match.filePath)}:${String(match.line)}`),
    }))
    .sort((a, b) => b.calls - a.calls || a.command.localeCompare(b.command));
}

function printCommandSummaryTable(summaries: readonly CommandSummary[], markdown: boolean): void {
  if (markdown) {
    console.log("| command | calls | helper APIs | files | examples |");
    console.log("|---|---:|---|---:|---|");
    for (const summary of summaries) {
      console.log(
        `| \`${summary.command}\` | ${String(summary.calls)} | ${summary.helpers.join(", ")} | ${String(summary.files)} | ${summary.examples.join("<br>")} |`,
      );
    }
    return;
  }

  console.log("command\tcalls\thelper APIs\tfiles\texamples");
  for (const summary of summaries) {
    console.log(
      [
        summary.command,
        String(summary.calls),
        summary.helpers.join(", "),
        String(summary.files),
        summary.examples.join(", "),
      ].join("\t"),
    );
  }
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const files = collectFiles(options.rootDir, options.roots, options.excludeTests);
  const matches = files
    .flatMap((filePath) => scanFile(filePath, options))
    .sort(
      (a, b) =>
        a.filePath.localeCompare(b.filePath) ||
        a.line - b.line ||
        a.column - b.column ||
        a.kind.localeCompare(b.kind),
    );

  if (options.groupByCommand) {
    const summaries = summarizeByCommand(matches, options.rootDir);
    if (options.json) {
      console.log(JSON.stringify(summaries, null, 2));
      return;
    }
    printCommandSummaryTable(summaries, options.markdown);
    return;
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        matches.map((match) => ({
          ...match,
          filePath: toPosixRelative(options.rootDir, match.filePath),
        })),
        null,
        2,
      ),
    );
    return;
  }

  console.log(
    `Found ${String(matches.length)} command-helper ${matches.length === 1 ? "use" : "uses"} across ${String(files.length)} file(s).`,
  );
  for (const match of matches) {
    console.log("");
    console.log(formatMatch(match, options.rootDir));
  }
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`list-command-helper-uses failed: ${message}`);
  process.exit(2);
}

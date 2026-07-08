// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Verifies that the starter prompt pins the reviewed credential helper and form bytes.
 *
 * NemoClaw uses squash-only merges, so the intermediate artifact commit is not
 * an ancestor of the merged commit and may be absent from shallow checkouts.
 * This check therefore binds each local file to its advertised SHA-256 and a
 * full immutable URL. The prompt verifies fetched bytes and fails closed if
 * GitHub cannot serve that intermediate commit.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const STARTER_PROMPT_PATH = "docs/_components/StarterPrompt.tsx";
const HELPER_PATH = "scripts/local-credential-helper.mts";
const FORM_PATH = "docs/resources/local-credential-form.html";
const CREDENTIAL_ENV_PATH = "src/lib/security/credential-env.ts";
const PROCESS_CONTROL_ENV_PATH = "src/lib/security/process-control-env.ts";

type ReviewedArtifact = Readonly<{
  label: string;
  relativePath: string;
}>;

const REVIEWED_ARTIFACTS: readonly ReviewedArtifact[] = [
  { label: "helper", relativePath: HELPER_PATH },
  { label: "form", relativePath: FORM_PATH },
];

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findCredentialSection(promptSource: string): string {
  const match = promptSource.match(
    /## Handle Tokens Securely and Visually([\s\S]*?)\nUse this provider mapping/,
  );
  if (!match?.[1]) throw new Error("Starter prompt credential section is missing");
  return match[1];
}

function verifyArtifact(section: string, artifact: ReviewedArtifact): string[] {
  const failures: string[] = [];
  const currentBytes = fs.readFileSync(path.join(REPO_ROOT, artifact.relativePath));
  const currentDigest = sha256(currentBytes);
  const urlPattern = new RegExp(
    `https://raw\\.githubusercontent\\.com/NVIDIA/NemoClaw/([0-9a-f]{40})/${escapeRegExp(artifact.relativePath)}`,
    "g",
  );
  const matches = [...section.matchAll(urlPattern)];
  const match = matches[0];
  if (matches.length !== 1 || !match?.[1] || match.index === undefined) {
    return [`${artifact.label}: expected exactly one immutable raw GitHub URL`];
  }

  const lineStart = section.lastIndexOf("\n", match.index) + 1;
  const nextLine = section.indexOf("\n", match.index);
  const pinnedLine = section.slice(lineStart, nextLine < 0 ? undefined : nextLine);
  if (!pinnedLine.includes(currentDigest)) {
    failures.push(`${artifact.label}: immutable URL is not paired with SHA-256 ${currentDigest}`);
  }
  return failures;
}

function verifyPackageFiles(): string[] {
  const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
    files?: unknown;
  };
  if (!Array.isArray(packageJson.files)) return ["package.json: files must be an array"];
  const failures: string[] = [];
  if (!packageJson.files.includes("scripts/")) {
    failures.push("package.json: scripts/ must ship the credential helper");
  }
  if (!packageJson.files.includes(FORM_PATH)) {
    failures.push(`package.json: ${FORM_PATH} must ship with the helper`);
  }
  if ((fs.statSync(path.join(REPO_ROOT, HELPER_PATH)).mode & 0o111) === 0) {
    failures.push(`${HELPER_PATH}: helper must remain executable`);
  }
  return failures;
}

function verifyEmbeddedFormDigest(): string[] {
  const helperSource = fs.readFileSync(path.join(REPO_ROOT, HELPER_PATH), "utf8");
  const embeddedDigest = extractEmbeddedFormDigest(helperSource, HELPER_PATH);
  const formDigest = sha256(fs.readFileSync(path.join(REPO_ROOT, FORM_PATH)));
  return embeddedDigest === formDigest
    ? []
    : [`${HELPER_PATH}: embedded form digest does not match ${FORM_PATH}`];
}

function executableSourceFile(source: string, relativePath: string): ts.SourceFile {
  if (!relativePath.endsWith(".html")) {
    const scriptKind = relativePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    return ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true, scriptKind);
  }
  const scripts = [...source.matchAll(/<script>([\s\S]*?)<\/script>/gi)];
  if (scripts.length !== 1 || scripts[0][1] === undefined) {
    throw new Error(`${relativePath}: expected exactly one inline script`);
  }
  return ts.createSourceFile(
    relativePath,
    scripts[0][1],
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
}

function namedVariableInitializer(
  source: string,
  variableName: string,
  relativePath: string,
): ts.Expression {
  const sourceFile = executableSourceFile(source, relativePath);
  const declarations = sourceFile.statements.flatMap((statement) =>
    ts.isVariableStatement(statement)
      ? [...statement.declarationList.declarations].filter(
          (declaration) =>
            ts.isIdentifier(declaration.name) && declaration.name.text === variableName,
        )
      : [],
  );
  const declaration = declarations[0];
  if (
    declarations.length !== 1 ||
    declaration === undefined ||
    declaration.initializer === undefined ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0
  ) {
    throw new Error(`${relativePath}: expected exactly one executable const ${variableName}`);
  }
  return declaration.initializer;
}

export function extractCredentialPattern(source: string, relativePath: string): string {
  const initializer = namedVariableInitializer(
    source,
    "CREDENTIAL_SHAPED_NAME_PATTERN",
    relativePath,
  );
  if (!ts.isRegularExpressionLiteral(initializer)) {
    throw new Error(`${relativePath}: credential-shaped name pattern must be a regex literal`);
  }
  return initializer.text;
}

export function extractEmbeddedFormDigest(source: string, relativePath: string): string {
  const initializer = namedVariableInitializer(
    source,
    "EXPECTED_LOCAL_CREDENTIAL_FORM_SHA256",
    relativePath,
  );
  if (!ts.isStringLiteral(initializer) || !/^[a-f0-9]{64}$/.test(initializer.text)) {
    throw new Error(`${relativePath}: embedded form digest must be a lowercase SHA-256 literal`);
  }
  return initializer.text;
}

export function extractStarterPrompt(source: string, relativePath: string): string {
  const initializer = namedVariableInitializer(source, "STARTER_PROMPT", relativePath);
  if (!ts.isStringLiteral(initializer) && !ts.isNoSubstitutionTemplateLiteral(initializer)) {
    throw new Error(`${relativePath}: STARTER_PROMPT must be one static string literal`);
  }
  return initializer.text;
}

export function extractStringSet(source: string, setName: string, relativePath: string): string[] {
  const initializer = namedVariableInitializer(source, setName, relativePath);
  if (
    !ts.isNewExpression(initializer) ||
    !isIdentifierNamed(initializer.expression, "Set") ||
    initializer.arguments?.length !== 1 ||
    !ts.isArrayLiteralExpression(initializer.arguments[0])
  ) {
    throw new Error(`${relativePath}: ${setName} must be a Set of string literals`);
  }
  return initializer.arguments[0].elements
    .map((element) => supportedRuleValue(element, relativePath))
    .sort();
}

function namedFunctionDeclaration(
  source: string,
  functionName: string,
  relativePath: string,
): ts.FunctionDeclaration {
  const sourceFile = executableSourceFile(source, relativePath);
  const declarations = sourceFile.statements.filter(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === functionName,
  );
  if (declarations.length !== 1 || declarations[0].body === undefined) {
    throw new Error(`${relativePath}: expected exactly one executable ${functionName} function`);
  }
  const declaration = declarations[0];
  const parameter = declaration.parameters[0];
  const hasUnsupportedModifier =
    declaration.modifiers?.some((modifier) => modifier.kind !== ts.SyntaxKind.ExportKeyword) ??
    false;
  if (
    hasUnsupportedModifier ||
    declaration.asteriskToken !== undefined ||
    declaration.parameters.length !== 1 ||
    parameter === undefined ||
    !ts.isIdentifier(parameter.name) ||
    parameter.name.text !== "name" ||
    parameter.dotDotDotToken !== undefined ||
    parameter.questionToken !== undefined ||
    parameter.initializer !== undefined
  ) {
    throw new Error(
      `${relativePath}: ${functionName} must be a synchronous one-argument predicate over name`,
    );
  }
  return declaration;
}

function stripParentheses(expression: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(expression)
    ? stripParentheses(expression.expression)
    : expression;
}

function isIdentifierNamed(expression: ts.Expression, name: string): boolean {
  return ts.isIdentifier(expression) && expression.text === name;
}

function supportedRuleValue(expression: ts.Expression, relativePath: string): string {
  if (!ts.isStringLiteral(expression) || !/^[A-Z0-9_]+$/.test(expression.text)) {
    throw new Error(`${relativePath}: process-control rule must use an uppercase string literal`);
  }
  return expression.text;
}

function extractRuleAtoms(
  expression: ts.Expression,
  setName: string,
  relativePath: string,
): string[] {
  const node = stripParentheses(expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
    return [
      ...extractRuleAtoms(node.left, setName, relativePath),
      ...extractRuleAtoms(node.right, setName, relativePath),
    ];
  }
  if (
    ts.isCallExpression(node) &&
    node.arguments.length === 1 &&
    ts.isPropertyAccessExpression(node.expression)
  ) {
    const receiver = stripParentheses(node.expression.expression);
    if (
      node.expression.name.text === "has" &&
      isIdentifierNamed(receiver, setName) &&
      isIdentifierNamed(node.arguments[0], "name")
    ) {
      return ["literal-set"];
    }
    if (node.expression.name.text === "startsWith" && isIdentifierNamed(receiver, "name")) {
      return [`prefix:${supportedRuleValue(node.arguments[0], relativePath)}`];
    }
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
    isIdentifierNamed(node.left, "name")
  ) {
    return [`exact:${supportedRuleValue(node.right, relativePath)}`];
  }
  throw new Error(`${relativePath}: process-control predicate uses unsupported logic`);
}

export function extractProcessControlRules(
  source: string,
  functionName: string,
  setName: string,
  relativePath: string,
): string[] {
  const declaration = namedFunctionDeclaration(source, functionName, relativePath);
  const statements = declaration.body?.statements ?? [];
  if (
    statements.length !== 1 ||
    !ts.isReturnStatement(statements[0]) ||
    statements[0].expression === undefined
  ) {
    throw new Error(`${relativePath}: ${functionName} must contain exactly one return expression`);
  }
  const rules = extractRuleAtoms(statements[0].expression, setName, relativePath);
  if (!rules.includes("literal-set")) {
    throw new Error(`${relativePath}: ${functionName} must check ${setName}`);
  }
  return rules.sort();
}

type FieldSafetySources = Readonly<{
  canonicalCredential: string;
  canonicalProcessControl: string;
  form: string;
  helper: string;
}>;

export function verifyFieldSafetySourceParity(sources: FieldSafetySources): string[] {
  const failures: string[] = [];
  const canonicalCredentialPattern = extractCredentialPattern(
    sources.canonicalCredential,
    CREDENTIAL_ENV_PATH,
  );
  const helperCredentialPattern = extractCredentialPattern(sources.helper, HELPER_PATH);
  const formCredentialPattern = extractCredentialPattern(sources.form, FORM_PATH);
  if (helperCredentialPattern !== formCredentialPattern) {
    failures.push("helper and form credential-shaped name patterns must match exactly");
  }
  if (helperCredentialPattern !== canonicalCredentialPattern) {
    failures.push("helper credential-shaped name pattern must match the canonical security policy");
  }
  if (formCredentialPattern !== canonicalCredentialPattern) {
    failures.push("form credential-shaped name pattern must match the canonical security policy");
  }
  const canonicalControlNames = extractStringSet(
    sources.canonicalProcessControl,
    "PROCESS_CONTROL_ENV_NAMES",
    PROCESS_CONTROL_ENV_PATH,
  );
  const helperControlNames = extractStringSet(
    sources.helper,
    "FORBIDDEN_CHILD_ENV_NAMES",
    HELPER_PATH,
  );
  const formControlNames = extractStringSet(sources.form, "PROCESS_CONTROL_FIELD_NAMES", FORM_PATH);
  if (helperControlNames.join("\n") !== formControlNames.join("\n")) {
    failures.push("helper and form process-control environment name sets must match exactly");
  }
  if (helperControlNames.join("\n") !== canonicalControlNames.join("\n")) {
    failures.push(
      "helper process-control environment names must match the canonical security policy",
    );
  }
  if (formControlNames.join("\n") !== canonicalControlNames.join("\n")) {
    failures.push(
      "form process-control environment names must match the canonical security policy",
    );
  }
  const canonicalControlRules = extractProcessControlRules(
    sources.canonicalProcessControl,
    "isProcessControlEnvName",
    "PROCESS_CONTROL_ENV_NAMES",
    PROCESS_CONTROL_ENV_PATH,
  );
  const helperControlRules = extractProcessControlRules(
    sources.helper,
    "isForbiddenChildEnvName",
    "FORBIDDEN_CHILD_ENV_NAMES",
    HELPER_PATH,
  );
  const formControlRules = extractProcessControlRules(
    sources.form,
    "isProcessControlFieldName",
    "PROCESS_CONTROL_FIELD_NAMES",
    FORM_PATH,
  );
  if (helperControlRules.join("\n") !== formControlRules.join("\n")) {
    failures.push("helper and form process-control predicate rules must match exactly");
  }
  if (helperControlRules.join("\n") !== canonicalControlRules.join("\n")) {
    failures.push("helper process-control predicate must match the canonical security policy");
  }
  if (formControlRules.join("\n") !== canonicalControlRules.join("\n")) {
    failures.push("form process-control predicate must match the canonical security policy");
  }
  return failures;
}

function verifyFieldSafetyRules(): string[] {
  return verifyFieldSafetySourceParity({
    canonicalCredential: fs.readFileSync(path.join(REPO_ROOT, CREDENTIAL_ENV_PATH), "utf8"),
    canonicalProcessControl: fs.readFileSync(
      path.join(REPO_ROOT, PROCESS_CONTROL_ENV_PATH),
      "utf8",
    ),
    form: fs.readFileSync(path.join(REPO_ROOT, FORM_PATH), "utf8"),
    helper: fs.readFileSync(path.join(REPO_ROOT, HELPER_PATH), "utf8"),
  });
}

function main(): void {
  const starterPromptSource = fs.readFileSync(path.join(REPO_ROOT, STARTER_PROMPT_PATH), "utf8");
  const prompt = extractStarterPrompt(starterPromptSource, STARTER_PROMPT_PATH);
  const section = findCredentialSection(prompt);
  const sectionDigests = [...section.matchAll(/\b[a-f0-9]{64}\b/g)].map(([digest]) => digest);
  const expectedDigests = REVIEWED_ARTIFACTS.map(({ relativePath }) =>
    sha256(fs.readFileSync(path.join(REPO_ROOT, relativePath))),
  );
  const pinnedCommits = REVIEWED_ARTIFACTS.flatMap(({ relativePath }) => {
    const pattern = new RegExp(
      `https://raw\\.githubusercontent\\.com/NVIDIA/NemoClaw/([0-9a-f]{40})/${escapeRegExp(relativePath)}`,
    );
    const commit = section.match(pattern)?.[1];
    return commit ? [commit] : [];
  });
  const failures = [
    ...REVIEWED_ARTIFACTS.flatMap((artifact) => verifyArtifact(section, artifact)),
    ...verifyEmbeddedFormDigest(),
    ...verifyFieldSafetyRules(),
    ...verifyPackageFiles(),
  ];
  if (
    sectionDigests.length !== expectedDigests.length ||
    [...sectionDigests].sort().join("\n") !== [...expectedDigests].sort().join("\n")
  ) {
    failures.push("starter prompt credential section must contain only the two current digests");
  }
  if (pinnedCommits.length !== REVIEWED_ARTIFACTS.length || new Set(pinnedCommits).size !== 1) {
    failures.push("starter prompt helper and form URLs must pin the same commit");
  }

  if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exit(1);
  }
  console.log("Local credential helper and form pins are immutable and current.");
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) main();

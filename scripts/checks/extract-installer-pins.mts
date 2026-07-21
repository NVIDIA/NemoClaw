// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Token = {
  end: number;
  kind: "newline" | "operator" | "word";
  start: number;
  value: string;
};

export type InstallerPin = {
  asset: string;
  releaseVersion: string;
  sha256: string;
  source: string;
};

type ExtractOptions = {
  functionName: string;
  sourceLabel: string;
};

type SandboxBuildPin = {
  sha256: string;
  version: string;
};

type CliOptions = {
  blueprint: string;
  brevInstaller: string;
  format: "json" | "tsv";
  installer: string;
};

const FUNCTION_LOCAL_SOURCE_PATTERN =
  /^local[ \t]+release_tag[ \t]*=[ \t]*(?:"\$1"|\$1)[ \t]+asset[ \t]*=[ \t]*(?:"\$2"|\$2)$/u;
const LITERAL_PIN_PATTERN = /^v([0-9]+\.[0-9]+\.[0-9]+):([A-Za-z0-9._+-]+)$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_INSTALLER_INPUT_BYTES = 1024 * 1024;
// These hashes freeze the complete reviewed scripts after normalizing only the
// strictly parsed pin-table function and stable release selector. Update them
// only in a prerequisite trust-anchor PR that keeps the currently selected
// release; the later pin PR may then change release data without authorizing
// any operational installer change. A mismatch reports the candidate hash.
const TRUSTED_INSTALLER_TEMPLATE_SHA256 =
  "a101f002bd8e02aa7b38960ddcb76c9fca419bc3766f6870446f6a7e99e14d78";
const TRUSTED_BREV_TEMPLATE_SHA256 =
  "c0a4ddf25a02a9fe02b2df53a60942ea887610f04d4ce16a121b6e79a5aeff1a";
const EXPECTED_INSTALLER_ASSETS = [
  "openshell-x86_64-unknown-linux-musl.tar.gz",
  "openshell-aarch64-unknown-linux-musl.tar.gz",
  "openshell-aarch64-apple-darwin.tar.gz",
  "openshell-gateway-x86_64-unknown-linux-gnu.tar.gz",
  "openshell-gateway-aarch64-unknown-linux-gnu.tar.gz",
  "openshell-gateway-aarch64-apple-darwin.tar.gz",
  "openshell-sandbox-x86_64-unknown-linux-gnu.tar.gz",
  "openshell-sandbox-aarch64-unknown-linux-gnu.tar.gz",
] as const;
const EXPECTED_BREV_ASSETS = [
  "openshell-x86_64-unknown-linux-musl.tar.gz",
  "openshell-aarch64-unknown-linux-musl.tar.gz",
] as const;

function fail(message: string): never {
  throw new Error(`Installer pin extraction failed: ${message}`);
}

// Pull-request CI executes this parser from a trusted checkout while these
// paths point into the mutable PR tree. Reject links and special files before
// reading, verify that the opened file is still the one inspected, and cap the
// bytes consumed so PR-authored input cannot redirect or exhaust the verifier.
// Regression coverage lives in test/installer-hash-check.test.ts.
function readInstallerInput(inputPath: string, sourceLabel: string): string {
  let parentStats: fs.Stats;
  try {
    parentStats = fs.lstatSync(path.dirname(inputPath));
  } catch {
    fail(`${sourceLabel} input parent directory is unavailable`);
  }
  if (parentStats.isSymbolicLink() || !parentStats.isDirectory()) {
    fail(`${sourceLabel} input parent must be a real directory and not a symbolic link`);
  }

  let pathStats: fs.Stats;
  try {
    pathStats = fs.lstatSync(inputPath);
  } catch {
    fail(`${sourceLabel} input is unavailable`);
  }
  if (pathStats.isSymbolicLink() || !pathStats.isFile()) {
    fail(`${sourceLabel} input must be a regular file and not a symbolic link`);
  }

  let descriptor: number;
  try {
    descriptor = fs.openSync(
      inputPath,
      fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW,
    );
  } catch {
    fail(`${sourceLabel} input must be a regular file and not a symbolic link`);
  }

  try {
    const openedStats = fs.fstatSync(descriptor);
    if (
      !openedStats.isFile() ||
      openedStats.dev !== pathStats.dev ||
      openedStats.ino !== pathStats.ino
    ) {
      fail(`${sourceLabel} input changed during validation or is not a regular file`);
    }
    if (openedStats.size > MAX_INSTALLER_INPUT_BYTES) {
      fail(`${sourceLabel} input exceeds the ${MAX_INSTALLER_INPUT_BYTES}-byte limit`);
    }

    const buffer = Buffer.allocUnsafe(MAX_INSTALLER_INPUT_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const chunkSize = fs.readSync(descriptor, buffer, bytesRead, buffer.length - bytesRead, null);
      if (chunkSize === 0) {
        break;
      }
      bytesRead += chunkSize;
    }
    if (bytesRead > MAX_INSTALLER_INPUT_BYTES) {
      fail(`${sourceLabel} input exceeds the ${MAX_INSTALLER_INPUT_BYTES}-byte limit`);
    }
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}

// invalidState: base-trusted CI accepts the right number of valid published
// hashes while a pull request swaps in a different official release asset.
// sourceBoundary: these expected asset names live only in base-trusted parser
// code; the PR-head installer and Brev script remain inert input data.
// whyNotSourceFix: OpenShell can attest what it publishes but cannot determine
// which exact downstream assets NemoClaw consumes.
// regressionTest: test/installer-hash-check.test.ts substitutes official but
// unexpected assets while keeping valid upstream digests and record counts.
// removalCondition: remove this set check only when one base-trusted canonical
// dependency manifest directly drives both installer consumers.
function assertExactAssetSet(
  pins: InstallerPin[],
  expectedAssets: readonly string[],
  label: string,
): void {
  const actual = [...new Set(pins.map((pin) => pin.asset))].sort();
  const expected = [...expectedAssets].sort();
  const missing = expected.filter((asset) => !actual.includes(asset));
  const unexpected = actual.filter((asset) => !expected.includes(asset));
  if (missing.length > 0 || unexpected.length > 0) {
    fail(
      `${label} must contain the exact consumed asset set; ` +
        `missing=[${missing.join(", ")}], unexpected=[${unexpected.join(", ")}]`,
    );
  }
}

// invalidState: the blueprint and stable runtime selectors request a newer
// OpenShell release while both embedded hash tables still name an older,
// independently valid release, so separate dependency and hash checks pass but
// installation cannot find a hash for the selected version.
// sourceBoundary: this base-trusted parser reads the PR blueprint and installer
// sources only as inert, bounded files and binds every stable selector to the
// single release extracted from the static hash tables.
// whyNotSourceFix: OpenShell can attest its release but cannot keep NemoClaw's
// blueprint, installer selector, Brev selector, and embedded tables coherent.
// regressionTest: test/installer-hash-check.test.ts moves all runtime consumers
// to 0.0.85 while leaving both valid pin tables at 0.0.72 and requires failure.
// removalCondition: remove these comparisons only when one base-trusted,
// machine-readable pin manifest directly drives every runtime consumer.
function extractSingleVersion(
  source: string,
  pattern: RegExp,
  label: string,
  captureIndex = 1,
): string {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const matches = [...source.matchAll(new RegExp(pattern.source, flags))];
  const version = matches[0]?.[captureIndex];
  if (matches.length !== 1 || !version) {
    fail(`${label} must contain exactly one literal X.Y.Z version`);
  }
  return version;
}

function extractBlueprintMaxVersion(source: string): string {
  return extractSingleVersion(
    source,
    /^max_openshell_version:\s*(["'])([0-9]+\.[0-9]+\.[0-9]+)\1\s*$/gm,
    "blueprint max_openshell_version",
    2,
  );
}

function extractInstallerRuntimeVersion(source: string): string {
  const maxVersion = extractSingleVersion(
    source,
    /^MAX_VERSION="([0-9]+\.[0-9]+\.[0-9]+)"\s*$/gm,
    "installer MAX_VERSION",
  );
  const pinVersionAssignments = [...source.matchAll(/^PIN_VERSION=(.*)\s*$/gm)];
  if (
    pinVersionAssignments.length !== 1 ||
    pinVersionAssignments[0]?.[1]?.trim() !== '"$MAX_VERSION"'
  ) {
    fail('installer PIN_VERSION must be exactly "$MAX_VERSION"');
  }
  return maxVersion;
}

function extractInstallerMinimumVersion(source: string): string {
  return extractSingleVersion(
    source,
    /^MIN_VERSION="([0-9]+\.[0-9]+\.[0-9]+)"\s*$/gm,
    "installer MIN_VERSION",
  );
}

function extractInstallerDevelopmentMinimumVersion(source: string): string {
  return extractSingleVersion(
    source,
    /^DEV_MIN_VERSION="([0-9]+\.[0-9]+\.[0-9]+)"\s*$/gm,
    "installer DEV_MIN_VERSION",
  );
}

function extractBrevStableRuntimeVersion(source: string): string {
  return extractSingleVersion(
    source,
    /^\s*stable\s*\|\s*auto\)\s*OPENSHELL_VERSION="v([0-9]+\.[0-9]+\.[0-9]+)"\s*;;\s*$/gm,
    "Brev stable OpenShell default",
  );
}

function isOperatorStart(character: string): boolean {
  return "(){};".includes(character);
}

function tokenizeShellSubset(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < source.length) {
    const character = source[index] ?? "";
    const next = source[index + 1] ?? "";

    if (character === "\\" && (next === "\n" || (next === "\r" && source[index + 2] === "\n"))) {
      index += next === "\n" ? 2 : 3;
      continue;
    }
    if (character === " " || character === "\t" || character === "\r") {
      index += 1;
      continue;
    }
    if (character === "\n") {
      tokens.push({
        end: index + 1,
        kind: "newline",
        start: index,
        value: "\n",
      });
      index += 1;
      continue;
    }
    if (character === "#") {
      while (index < source.length && source[index] !== "\n") {
        index += 1;
      }
      continue;
    }
    if (character === ";" && next === ";") {
      tokens.push({
        end: index + 2,
        kind: "operator",
        start: index,
        value: ";;",
      });
      index += 2;
      continue;
    }
    if (isOperatorStart(character)) {
      tokens.push({
        end: index + 1,
        kind: "operator",
        start: index,
        value: character,
      });
      index += 1;
      continue;
    }

    const wordStart = index;
    let value = "";
    while (index < source.length) {
      const wordCharacter = source[index] ?? "";
      const wordNext = source[index + 1] ?? "";
      if (
        wordCharacter === " " ||
        wordCharacter === "\t" ||
        wordCharacter === "\r" ||
        wordCharacter === "\n" ||
        isOperatorStart(wordCharacter)
      ) {
        break;
      }
      if (wordCharacter === "\\") {
        if (wordNext === "\n" || (wordNext === "\r" && source[index + 2] === "\n")) {
          index += wordNext === "\n" ? 2 : 3;
          continue;
        }
        if (!wordNext) {
          fail("source ends with an incomplete escape");
        }
        value += wordNext;
        index += 2;
        continue;
      }
      if (wordCharacter === "'") {
        const closingQuote = source.indexOf("'", index + 1);
        if (closingQuote === -1) {
          fail("source contains an unterminated single-quoted word");
        }
        value += source.slice(index + 1, closingQuote);
        index = closingQuote + 1;
        continue;
      }
      if (wordCharacter === '"') {
        index += 1;
        let closed = false;
        while (index < source.length) {
          const quotedCharacter = source[index] ?? "";
          const quotedNext = source[index + 1] ?? "";
          if (quotedCharacter === '"') {
            index += 1;
            closed = true;
            break;
          }
          if (quotedCharacter === "\\") {
            if (quotedNext === "\n" || (quotedNext === "\r" && source[index + 2] === "\n")) {
              index += quotedNext === "\n" ? 2 : 3;
              continue;
            }
            if ('$`"\\'.includes(quotedNext)) {
              value += quotedNext;
              index += 2;
              continue;
            }
          }
          value += quotedCharacter;
          index += 1;
        }
        if (!closed) {
          fail("source contains an unterminated double-quoted word");
        }
        continue;
      }
      value += wordCharacter;
      index += 1;
    }
    if (!value) {
      fail(`unsupported shell token near ${JSON.stringify(source.slice(index, index + 16))}`);
    }
    tokens.push({ end: index, kind: "word", start: wordStart, value });
  }

  return tokens;
}

function isToken(token: Token | undefined, kind: Token["kind"], value?: string): boolean {
  return token?.kind === kind && (value === undefined || token.value === value);
}

function rawToken(source: string, token: Token | undefined): string {
  if (!token) fail("required shell token is unavailable");
  return source.slice(token.start, token.end);
}

function functionBodyRanges(tokens: Token[], functionName: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (let index = 0; index < tokens.length - 3; index += 1) {
    const nameIndex = isToken(tokens[index], "word", "function") ? index + 1 : index;
    if (!isToken(tokens[nameIndex], "word", functionName)) {
      continue;
    }
    let cursor = nameIndex + 1;
    if (isToken(tokens[cursor], "operator", "(")) {
      if (!isToken(tokens[cursor + 1], "operator", ")")) {
        continue;
      }
      cursor += 2;
    }
    if (!isToken(tokens[cursor], "operator", "{")) {
      continue;
    }

    let depth = 1;
    for (let bodyCursor = cursor + 1; bodyCursor < tokens.length; bodyCursor += 1) {
      if (isToken(tokens[bodyCursor], "operator", "{")) {
        depth += 1;
      } else if (isToken(tokens[bodyCursor], "operator", "}")) {
        depth -= 1;
        if (depth === 0) {
          ranges.push([cursor + 1, bodyCursor]);
          index = bodyCursor;
          break;
        }
      }
    }
    if (depth !== 0) {
      fail(`${functionName} has an unterminated function body`);
    }
  }
  return ranges;
}

type SourceEdit = {
  end: number;
  replacement: string;
  start: number;
};

function functionDefinitionSourceRanges(source: string, functionName: string): SourceEdit[] {
  const tokens = tokenizeShellSubset(source);
  const ranges: SourceEdit[] = [];
  for (let index = 0; index < tokens.length - 3; index += 1) {
    const definitionStart = index;
    const nameIndex = isToken(tokens[index], "word", "function") ? index + 1 : index;
    if (!isToken(tokens[nameIndex], "word", functionName)) continue;
    let cursor = nameIndex + 1;
    if (isToken(tokens[cursor], "operator", "(")) {
      if (!isToken(tokens[cursor + 1], "operator", ")")) continue;
      cursor += 2;
    }
    if (!isToken(tokens[cursor], "operator", "{")) continue;

    let depth = 1;
    for (let bodyCursor = cursor + 1; bodyCursor < tokens.length; bodyCursor += 1) {
      if (isToken(tokens[bodyCursor], "operator", "{")) {
        depth += 1;
      } else if (isToken(tokens[bodyCursor], "operator", "}")) {
        depth -= 1;
        if (depth === 0) {
          const start = tokens[definitionStart]?.start;
          const end = tokens[bodyCursor]?.end;
          if (start === undefined || end === undefined) {
            fail(`${functionName} source range is unavailable`);
          }
          ranges.push({
            end,
            replacement: `<${functionName}:trusted-release-data>`,
            start,
          });
          index = bodyCursor;
          break;
        }
      }
    }
    if (depth !== 0) fail(`${functionName} has an unterminated function body`);
  }
  return ranges;
}

function selectorVersionEdit(source: string, pattern: RegExp, label: string): SourceEdit {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const matches = [...source.matchAll(new RegExp(pattern.source, flags))];
  const match = matches[0];
  const version = match?.[1];
  if (matches.length !== 1 || !match || !version || match.index === undefined) {
    fail(`${label} must contain exactly one permitted release selector literal`);
  }
  const relativeStart = match[0].indexOf(version);
  if (relativeStart === -1) fail(`${label} release selector range is unavailable`);
  const start = match.index + relativeStart;
  return {
    end: start + version.length,
    replacement: "<trusted-release-version>",
    start,
  };
}

// invalidState: a dependency pin PR needs to add standalone sandbox binary
// identities but could hide control flow or arbitrary commands inside the map
// if the whole function were normalized without first parsing its grammar.
// sourceBoundary: this base-trusted parser accepts only literal digest case
// alternatives that print literal versions and a fail-closed default branch.
// regressionTest: installer-hash-check.test.ts covers valid additions plus
// control-flow, unknown-command, duplicate-digest, and malformed-version edits.
// removalCondition: remove this parser only when the standalone sandbox build
// identity map is generated from a base-trusted machine-readable manifest.
function extractSandboxBuildPins(source: string): SandboxBuildPin[] {
  const functionName = "pinned_sandbox_build_version";
  const tokens = tokenizeShellSubset(source);
  const bodyRanges = functionBodyRanges(tokens, functionName);
  if (bodyRanges.length !== 1) {
    fail(`installer must contain exactly one ${functionName} release-data function`);
  }
  const [bodyStart, bodyEnd] = bodyRanges[0] ?? fail(`${functionName} body range is unavailable`);
  let cursor = skipSeparators(tokens, bodyStart);

  const localCommand = commandBeforeSeparator(tokens, cursor);
  if (
    localCommand.command.length !== 2 ||
    !isToken(localCommand.command[0], "word", "local") ||
    !isToken(localCommand.command[1], "word", "digest=$1") ||
    rawToken(source, localCommand.command[1]) !== 'digest="$1"'
  ) {
    fail(`${functionName} must begin with exactly local digest="$1"`);
  }
  cursor = skipSeparators(tokens, localCommand.next);

  const caseCommand = commandBeforeSeparator(tokens, cursor);
  if (
    caseCommand.command.length !== 3 ||
    !isToken(caseCommand.command[0], "word", "case") ||
    !isToken(caseCommand.command[1], "word", "$digest") ||
    rawToken(source, caseCommand.command[1]) !== '"$digest"' ||
    !isToken(caseCommand.command[2], "word", "in")
  ) {
    fail(`${functionName} must dispatch exactly on "$digest"`);
  }
  cursor = skipSeparators(tokens, caseCommand.next);

  const pins: SandboxBuildPin[] = [];
  const seenDigests = new Set<string>();
  let sawDefaultBranch = false;
  while (cursor < bodyEnd) {
    if (isToken(tokens[cursor], "word", "*")) {
      sawDefaultBranch = true;
      cursor += 1;
      if (!isToken(tokens[cursor], "operator", ")")) {
        fail(`${functionName} default branch must be exactly *)`);
      }
      cursor = skipSeparators(tokens, cursor + 1);
      const defaultCommand = commandBeforeSeparator(tokens, cursor);
      if (
        defaultCommand.command.length !== 2 ||
        !isToken(defaultCommand.command[0], "word", "return") ||
        !isToken(defaultCommand.command[1], "word", "1")
      ) {
        fail(`${functionName} default branch must return 1`);
      }
      cursor = skipSeparators(tokens, defaultCommand.next);
      if (!isToken(tokens[cursor], "operator", ";;")) {
        fail(`${functionName} default branch must end with ;;`);
      }
      cursor = skipSeparators(tokens, cursor + 1);
      if (!isToken(tokens[cursor], "word", "esac")) {
        fail(`${functionName} must end with esac after its default branch`);
      }
      cursor = skipSeparators(tokens, cursor + 1);
      if (cursor !== bodyEnd) {
        fail(`${functionName} contains commands after its case statement`);
      }
      break;
    }

    const digests: string[] = [];
    let expectDigest = true;
    while (cursor < bodyEnd && !isToken(tokens[cursor], "operator", ")")) {
      const token = tokens[cursor];
      if (expectDigest) {
        if (!isToken(token, "word") || !SHA256_PATTERN.test(token.value)) {
          fail(`${functionName} case patterns must contain literal SHA-256 digests`);
        }
        if (seenDigests.has(token.value)) {
          fail(`${functionName} contains duplicate digest ${token.value}`);
        }
        seenDigests.add(token.value);
        digests.push(token.value);
      } else if (!isToken(token, "word", "|")) {
        fail(`${functionName} digest alternatives must be separated by |`);
      }
      expectDigest = !expectDigest;
      cursor += 1;
    }
    if (digests.length === 0 || expectDigest || !isToken(tokens[cursor], "operator", ")")) {
      fail(`${functionName} contains a malformed digest case pattern`);
    }
    cursor = skipSeparators(tokens, cursor + 1);

    const printfCommand = commandBeforeSeparator(tokens, cursor);
    const version = printfCommand.command[2]?.value ?? "";
    if (
      printfCommand.command.length !== 3 ||
      !isToken(printfCommand.command[0], "word", "printf") ||
      !isToken(printfCommand.command[1], "word", "%s\\n") ||
      !/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(version)
    ) {
      fail(`${functionName} digest branches must print exactly one literal X.Y.Z version`);
    }
    for (const sha256 of digests) pins.push({ sha256, version });
    cursor = skipSeparators(tokens, printfCommand.next);
    if (!isToken(tokens[cursor], "operator", ";;")) {
      fail(`${functionName} digest branches must end with ;;`);
    }
    cursor = skipSeparators(tokens, cursor + 1);
  }

  if (!sawDefaultBranch) fail(`${functionName} must contain a fail-closed default branch`);
  if (pins.length === 0) fail(`${functionName} must contain at least one sandbox build pin`);
  return pins;
}

function normalizeTrustedInstallerTemplate(
  source: string,
  functionNames: readonly string[],
  selectorPatterns: readonly RegExp[],
  label: string,
): string {
  const functionRanges = functionNames.flatMap((functionName) => {
    const ranges = functionDefinitionSourceRanges(source, functionName);
    if (ranges.length !== 1) {
      fail(`${label} must contain exactly one ${functionName} release-data function`);
    }
    return ranges;
  });
  const edits = [
    ...functionRanges,
    ...selectorPatterns.map((pattern, index) =>
      selectorVersionEdit(source, pattern, `${label} selector ${index + 1}`),
    ),
  ].sort((left, right) => right.start - left.start);
  for (let index = 0; index < edits.length - 1; index += 1) {
    const current = edits[index];
    const next = edits[index + 1];
    if (current && next && next.end > current.start) {
      fail(`${label} normalized release-data regions overlap`);
    }
  }
  return edits.reduce(
    (normalized, edit) =>
      `${normalized.slice(0, edit.start)}${edit.replacement}${normalized.slice(edit.end)}`,
    source,
  );
}

// invalidState: a mutable PR leaves a valid-looking pin table in inert text but
// changes which release, URL, checksum verifier, archive validator, or install
// path actually executes. sourceBoundary: the expected hashes and normalizer
// execute from the base-trusted checkout; PR installer files are inert input.
// regressionTest: test/installer-hash-check.test.ts mutates comments, control
// flow, indirect selectors, SHA commands, and alternate download/extract paths.
// removalCondition: remove this template lock only when a base-trusted,
// machine-readable manifest directly drives every installer operation.
function assertTrustedTemplate(
  source: string,
  functionNames: readonly string[],
  selectorPatterns: readonly RegExp[],
  expectedSha256: string,
  label: string,
): void {
  const normalized = normalizeTrustedInstallerTemplate(
    source,
    functionNames,
    selectorPatterns,
    label,
  );
  const actualSha256 = createHash("sha256").update(normalized).digest("hex");
  if (actualSha256 !== expectedSha256) {
    fail(
      `${label} operational template is not base-trusted; ` +
        `expected_sha256=${expectedSha256}, actual_sha256=${actualSha256}`,
    );
  }
}

function skipSeparators(tokens: Token[], start: number): number {
  let cursor = start;
  while (isToken(tokens[cursor], "newline") || isToken(tokens[cursor], "operator", ";")) {
    cursor += 1;
  }
  return cursor;
}

function commandBeforeSeparator(
  tokens: Token[],
  start: number,
): { command: Token[]; next: number } {
  let cursor = start;
  while (
    cursor < tokens.length &&
    !isToken(tokens[cursor], "newline") &&
    !isToken(tokens[cursor], "operator", ";")
  ) {
    cursor += 1;
  }
  return {
    command: tokens.slice(start, cursor),
    next: skipSeparators(tokens, cursor),
  };
}

function staticPinFromArm(
  source: string,
  patternToken: Token,
  commandTokens: Token[],
): InstallerPin | undefined {
  const pattern = patternToken.value;
  const match = LITERAL_PIN_PATTERN.exec(pattern);
  const rawPattern = rawToken(source, patternToken);
  if (!match) {
    if (pattern !== "*") {
      fail(`unsupported case pattern ${JSON.stringify(pattern)}`);
    }
    if (rawPattern !== "*") {
      fail("the fallback case pattern must be one unquoted wildcard");
    }
    const wildcardTokens = commandTokens.filter(
      (token) => token.kind !== "newline" && token.value !== ";",
    );
    const wildcardCommand = wildcardTokens.map((token) => token.value);
    if (wildcardCommand.join(" ") !== "return 1") {
      fail("the fallback case arm must contain only 'return 1'");
    }
    if (
      rawToken(source, wildcardTokens[0]) !== "return" ||
      rawToken(source, wildcardTokens[1]) !== "1"
    ) {
      fail("the fallback case arm must use literal 'return 1'");
    }
    return undefined;
  }

  if (![pattern, `'${pattern}'`, `"${pattern}"`].includes(rawPattern)) {
    fail(`case arm ${pattern} must be one literal release-and-asset pattern`);
  }

  const staticCommandTokens = commandTokens.filter(
    (token) => token.kind !== "newline" && token.value !== ";",
  );
  const command = staticCommandTokens.map((token) => token.value);
  if (command.length !== 3 || command[0] !== "printf" || command[1] !== "%s\\n") {
    fail(`case arm ${pattern} must contain exactly one static printf '%s\\n' SHA-256 command`);
  }
  if (
    rawToken(source, staticCommandTokens[0]) !== "printf" ||
    !["'%s\\n'", '"%s\\n"'].includes(rawToken(source, staticCommandTokens[1]))
  ) {
    fail(`case arm ${pattern} must use a literal printf '%s\\n' command`);
  }
  const sha256 = command[2] ?? "";
  if (!SHA256_PATTERN.test(sha256)) {
    fail(`case arm ${pattern} does not contain one literal lowercase SHA-256 digest`);
  }
  if (![sha256, `'${sha256}'`, `"${sha256}"`].includes(rawToken(source, staticCommandTokens[2]))) {
    fail(`case arm ${pattern} must print one literal lowercase SHA-256 digest`);
  }
  return {
    asset: match[2] ?? "",
    releaseVersion: match[1] ?? "",
    sha256,
    source: "",
  };
}

// invalidState: trusted CI accepts a pin table whose shell formatting hides,
// duplicates, or changes a consumed release-asset digest.
// sourceBoundary: this trusted parser owns the accepted static shell subset;
// pull-request installer files provide data only and are never sourced or run.
// whyNotSourceFix: the bootstrap installers need self-contained shell lookup
// functions before package dependencies are available, so JSON is not their
// runtime source of truth.
// regressionTest: test/installer-hash-check.test.ts covers whitespace, comments,
// continuations, quote styles, mixed indentation, missing pins, and ambiguity.
// removalCondition: remove shell parsing when both installers and this verifier
// consume one canonical machine-readable pin manifest directly.
export function extractInstallerPins(source: string, options: ExtractOptions): InstallerPin[] {
  const tokens = tokenizeShellSubset(source);
  const ranges = functionBodyRanges(tokens, options.functionName);
  if (ranges.length !== 1) {
    fail(`expected exactly one ${options.functionName} definition, found ${ranges.length}`);
  }
  const headerIndex = tokens.findIndex(
    (token, index) =>
      token.kind === "word" &&
      token.value === options.functionName &&
      ((isToken(tokens[index + 1], "operator", "(") &&
        isToken(tokens[index + 2], "operator", ")") &&
        isToken(tokens[index + 3], "operator", "{")) ||
        isToken(tokens[index + 1], "operator", "{")),
  );
  if (headerIndex === -1 || rawToken(source, tokens[headerIndex]) !== options.functionName) {
    fail(`${options.functionName} must use one literal unquoted function name`);
  }
  if (
    isToken(tokens[headerIndex - 1], "word", "function") &&
    rawToken(source, tokens[headerIndex - 1]) !== "function"
  ) {
    fail(`${options.functionName} must use a literal function keyword`);
  }
  const [bodyStart, bodyEnd] = ranges[0] ?? fail(`missing ${options.functionName} body`);
  const body = tokens.slice(bodyStart, bodyEnd);
  let cursor = skipSeparators(body, 0);

  const local = commandBeforeSeparator(body, cursor);
  const localStart = local.command[0];
  const localEnd = local.command.at(-1);
  const localSource = localStart && localEnd ? source.slice(localStart.start, localEnd.end) : "";
  if (!FUNCTION_LOCAL_SOURCE_PATTERN.test(localSource)) {
    fail(`${options.functionName} must start with local release_tag and asset inputs`);
  }
  cursor = local.next;
  if (!isToken(body[cursor], "word", "case")) {
    fail(`${options.functionName} must contain one static case table`);
  }
  if (rawToken(source, body[cursor]) !== "case") {
    fail(`${options.functionName} must use a literal case keyword`);
  }
  const selector = body[cursor + 1];
  if (
    !isToken(selector, "word", "${release_tag}:${asset}") ||
    rawToken(source, selector) !== '"${release_tag}:${asset}"'
  ) {
    fail(`${options.functionName} must select on release_tag and asset`);
  }
  if (!isToken(body[cursor + 2], "word", "in")) {
    fail(`${options.functionName} case table is missing 'in'`);
  }
  if (rawToken(source, body[cursor + 2]) !== "in") {
    fail(`${options.functionName} must use a literal in keyword`);
  }
  cursor = skipSeparators(body, cursor + 3);

  const pins: InstallerPin[] = [];
  let fallbackCount = 0;
  while (!isToken(body[cursor], "word", "esac")) {
    const pattern = body[cursor];
    if (!isToken(pattern, "word") || !isToken(body[cursor + 1], "operator", ")")) {
      fail(`${options.functionName} contains an invalid case arm`);
    }
    cursor += 2;
    const commandStart = cursor;
    while (cursor < body.length && !isToken(body[cursor], "operator", ";;")) {
      cursor += 1;
    }
    if (cursor >= body.length) {
      fail(`${options.functionName} case arm ${pattern.value} is missing ';;'`);
    }
    const pin = staticPinFromArm(source, pattern, body.slice(commandStart, cursor));
    if (pattern.value === "*") {
      fallbackCount += 1;
    } else if (pin) {
      pins.push({ ...pin, source: options.sourceLabel });
    }
    cursor = skipSeparators(body, cursor + 1);
  }
  if (rawToken(source, body[cursor]) !== "esac") {
    fail(`${options.functionName} must use a literal esac keyword`);
  }
  cursor = skipSeparators(body, cursor + 1);
  if (cursor !== body.length) {
    fail(`${options.functionName} contains commands after its case table`);
  }
  if (fallbackCount !== 1) {
    fail(`${options.functionName} must contain exactly one fail-closed fallback arm`);
  }

  if (pins.length === 0) {
    fail(`${options.functionName} contains no versioned pins`);
  }
  const releaseVersions = [...new Set(pins.map((pin) => pin.releaseVersion))].sort();
  if (releaseVersions.length !== 1) {
    fail(
      `${options.functionName} must contain exactly one release version, found ${releaseVersions.join(", ")}`,
    );
  }

  const duplicateAssets = pins
    .map((pin) => pin.asset)
    .filter((asset, index, assets) => assets.indexOf(asset) !== index);
  if (duplicateAssets.length > 0) {
    fail(
      `${options.functionName} contains duplicate assets: ${[...new Set(duplicateAssets)].join(", ")}`,
    );
  }
  return pins;
}

function parseCliOptions(argv: string[]): CliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index] ?? "";
    const value = argv[index + 1] ?? "";
    if (!option.startsWith("--") || !value) {
      fail(
        "usage: extract-installer-pins.mts --blueprint PATH --installer PATH --brev-installer PATH [--format json|tsv]",
      );
    }
    if (values.has(option)) {
      fail(`duplicate CLI option ${option}`);
    }
    values.set(option, value);
  }
  const blueprint = values.get("--blueprint") ?? "";
  const installer = values.get("--installer") ?? "";
  const brevInstaller = values.get("--brev-installer") ?? "";
  const format = values.get("--format") ?? "json";
  const allowedOptions = new Set(["--blueprint", "--brev-installer", "--format", "--installer"]);
  const unknownOptions = [...values.keys()].filter((option) => !allowedOptions.has(option));
  if (
    unknownOptions.length > 0 ||
    !blueprint ||
    !installer ||
    !brevInstaller ||
    (format !== "json" && format !== "tsv")
  ) {
    fail(`invalid CLI options${unknownOptions.length > 0 ? `: ${unknownOptions.join(", ")}` : ""}`);
  }
  return { blueprint, brevInstaller, format, installer };
}

function runCli(): void {
  const options = parseCliOptions(process.argv.slice(2));
  const blueprintSource = readInstallerInput(options.blueprint, "blueprint");
  const installerSource = readInstallerInput(options.installer, "installer");
  const brevInstallerSource = readInstallerInput(options.brevInstaller, "Brev launchable");
  const installerPins = extractInstallerPins(installerSource, {
    functionName: "openshell_pinned_sha256",
    sourceLabel: "installer",
  });
  const brevPins = extractInstallerPins(brevInstallerSource, {
    functionName: "openshell_cli_pinned_sha256",
    sourceLabel: "Brev launchable",
  });
  assertExactAssetSet(installerPins, EXPECTED_INSTALLER_ASSETS, "installer pin table");
  assertExactAssetSet(brevPins, EXPECTED_BREV_ASSETS, "Brev pin table");
  const pins = [...installerPins, ...brevPins];
  const releaseVersions = [...new Set(pins.map((pin) => pin.releaseVersion))].sort();
  if (releaseVersions.length !== 1) {
    fail(
      `installer and Brev launchable pin tables must use the same release version, found ${releaseVersions.join(", ")}`,
    );
  }
  const releaseVersion = releaseVersions[0] ?? fail("installer pin tables contain no release");
  const sandboxBuildPins = extractSandboxBuildPins(installerSource);
  if (!sandboxBuildPins.some((pin) => pin.version === releaseVersion)) {
    fail(
      `pinned_sandbox_build_version must contain at least one digest for release ${releaseVersion}`,
    );
  }
  assertTrustedTemplate(
    installerSource,
    ["openshell_pinned_sha256", "pinned_sandbox_build_version"],
    [
      /^MIN_VERSION="([0-9]+\.[0-9]+\.[0-9]+)"$/gm,
      /^MAX_VERSION="([0-9]+\.[0-9]+\.[0-9]+)"$/gm,
      /^DEV_MIN_VERSION="([0-9]+\.[0-9]+\.[0-9]+)"$/gm,
    ],
    TRUSTED_INSTALLER_TEMPLATE_SHA256,
    "installer",
  );
  assertTrustedTemplate(
    brevInstallerSource,
    ["openshell_cli_pinned_sha256"],
    [/^\s*stable\s*\|\s*auto\)\s*OPENSHELL_VERSION="v([0-9]+\.[0-9]+\.[0-9]+)"\s*;;\s*$/gm],
    TRUSTED_BREV_TEMPLATE_SHA256,
    "Brev launchable",
  );
  for (const [label, runtimeVersion] of [
    ["blueprint max_openshell_version", extractBlueprintMaxVersion(blueprintSource)],
    ["installer MIN_VERSION", extractInstallerMinimumVersion(installerSource)],
    ["installer MAX_VERSION", extractInstallerRuntimeVersion(installerSource)],
    ["installer DEV_MIN_VERSION", extractInstallerDevelopmentMinimumVersion(installerSource)],
    ["Brev stable OpenShell default", extractBrevStableRuntimeVersion(brevInstallerSource)],
  ] as const) {
    if (runtimeVersion !== releaseVersion) {
      fail(`installer pin-table release ${releaseVersion} must match ${label} ${runtimeVersion}`);
    }
  }
  if (options.format === "json") {
    process.stdout.write(`${JSON.stringify(pins)}\n`);
    return;
  }
  process.stdout.write(
    pins
      .map((pin) => `${pin.releaseVersion}\t${pin.source}\t${pin.asset}\t${pin.sha256}`)
      .join("\n"),
  );
  process.stdout.write("\n");
}

const invokedPath = process.argv[1];
if (
  invokedPath &&
  fs.realpathSync(path.resolve(invokedPath)) === fs.realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

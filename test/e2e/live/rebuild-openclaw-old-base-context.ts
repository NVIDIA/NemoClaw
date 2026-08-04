// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REPO_ROOT } from "../fixtures/paths.ts";

const DOCKERFILE_BASE = path.join(REPO_ROOT, "Dockerfile.base");
const DOCKERIGNORE = path.join(REPO_ROOT, ".dockerignore");
const OLD_OPENCLAW_VERSION = "2026.3.11";
const BLUEPRINT_RELPATH = "nemoclaw-blueprint/blueprint.yaml";

interface LogicalDockerfileInstruction {
  lineNumber: number;
  text: string;
}

export function oldBaseContextSources(): string[] {
  return [BLUEPRINT_RELPATH, ...directDockerfileBaseCopySources()];
}

function logicalDockerfileInstructions(text: string): LogicalDockerfileInstruction[] {
  const instructions: LogicalDockerfileInstruction[] = [];
  let currentParts: string[] = [];
  let currentLineNumber = 0;
  let sawInstruction = false;

  for (const [lineIndex, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      if (!sawInstruction) {
        const escapeDirective = /^#\s*escape\s*=\s*(\S+)\s*$/i.exec(line);
        if (escapeDirective && escapeDirective[1] !== "\\") {
          throw new Error(
            `Unsupported Dockerfile.base escape directive at line ${lineIndex + 1}: ${rawLine}`,
          );
        }
      }
      continue;
    }

    sawInstruction = true;
    if (currentParts.length === 0) currentLineNumber = lineIndex + 1;

    const continued = line.endsWith("\\");
    const part = continued ? line.slice(0, -1).trimEnd() : line;
    if (!part) {
      throw new Error(
        `Unsupported Dockerfile.base continuation at line ${lineIndex + 1}: ${rawLine}`,
      );
    }
    currentParts.push(part);

    if (!continued) {
      const instruction = currentParts.join(" ");
      if (instruction.split(/\s+/).some((token) => token.startsWith("<<"))) {
        throw new Error(
          `Unsupported Dockerfile.base heredoc instruction at line ${currentLineNumber}: ${instruction}`,
        );
      }
      instructions.push({
        lineNumber: currentLineNumber,
        text: instruction,
      });
      currentParts = [];
      currentLineNumber = 0;
    }
  }

  if (currentParts.length > 0) {
    throw new Error(`Dangling Dockerfile.base continuation at line ${currentLineNumber}`);
  }
  return instructions;
}

function unsupportedDirectCopyForm(instruction: LogicalDockerfileInstruction): never {
  throw new Error(
    `Unsupported direct Dockerfile.base COPY form at line ${instruction.lineNumber}: ${instruction.text}`,
  );
}

function parseDirectCopyOperands(
  tokens: string[],
  instruction: LogicalDockerfileInstruction,
): string[] | null {
  let operandIndex = 0;
  while (operandIndex < tokens.length && tokens[operandIndex]?.startsWith("--")) {
    const flag = tokens[operandIndex]!;
    if (/^--from=.+$/i.test(flag)) return null;
    const reviewedDirectFlag =
      /^--(?:chown|chmod)=.+$/i.test(flag) ||
      /^--(?:link|parents)(?:=(?:true|false))?$/i.test(flag);
    if (!reviewedDirectFlag) unsupportedDirectCopyForm(instruction);
    operandIndex += 1;
  }

  const operands = tokens.slice(operandIndex);
  if (operands.length < 2 || operands.some((operand) => operand.startsWith("--"))) {
    unsupportedDirectCopyForm(instruction);
  }
  return operands;
}

export function directDockerfileBaseCopySources(dockerfilePath = DOCKERFILE_BASE): string[] {
  const text = fs.readFileSync(dockerfilePath, "utf8");
  const sources: string[] = [];

  for (const instruction of logicalDockerfileInstructions(text)) {
    const instructionMatch = /^(\S+)\b([\s\S]*)$/.exec(instruction.text);
    if (!instructionMatch || instructionMatch[1].toUpperCase() !== "COPY") continue;

    const copyForm = instructionMatch[2].trim();
    const tokens = copyForm.split(/\s+/).filter(Boolean);
    if (!copyForm || copyForm.startsWith("[")) unsupportedDirectCopyForm(instruction);

    const operands = parseDirectCopyOperands(tokens, instruction);
    if (operands === null) continue;

    for (const source of operands.slice(0, -1)) {
      validateOldBaseContextSource(source);
      sources.push(source);
    }
  }

  return sources;
}

export function dockerignoreSecretPatterns(dockerignorePath = DOCKERIGNORE): string[] {
  const patterns: string[] = [];
  let inSecuritySection = false;

  for (const rawLine of fs.readFileSync(dockerignorePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^#\s*Security:/i.test(line)) {
      inSecuritySection = true;
      continue;
    }
    if (!inSecuritySection || !line || line.startsWith("#")) continue;
    if (line.startsWith("!")) {
      throw new Error(`Unsupported negated .dockerignore security pattern: ${line}`);
    }
    patterns.push(line.replace(/^\.\//, ""));
  }

  if (patterns.length === 0) {
    throw new Error("No .dockerignore security patterns found");
  }
  return patterns;
}

function dockerignorePatternMatchesPath(pattern: string, relativePath: string): boolean {
  const normalizedPattern = pattern.replace(/^\/+/, "");
  const parts = relativePath.split("/");
  const fileName = parts.at(-1) ?? "";

  if (normalizedPattern.endsWith("/")) {
    const dirName = normalizedPattern.replace(/\/+$/, "");
    return parts.includes(dirName);
  }

  const target = normalizedPattern.includes("/") ? relativePath : fileName;
  const escaped = normalizedPattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(target);
}

function matchesDockerignoreSecretPattern(relativePath: string): boolean {
  return dockerignoreSecretPatterns().some((pattern) =>
    dockerignorePatternMatchesPath(pattern, relativePath),
  );
}

function validateOldBaseContextSource(relativePath: string): string {
  const parts = relativePath.split("/");
  const resolved = path.resolve(REPO_ROOT, relativePath);
  const repoPrefix = `${REPO_ROOT}${path.sep}`;
  const invalidSource =
    path.isAbsolute(relativePath) ||
    relativePath.includes("\\") ||
    /[$*?[\]"']/.test(relativePath) ||
    relativePath.startsWith("--") ||
    parts.some((part) => !part || part === "." || part === "..") ||
    (resolved !== REPO_ROOT && !resolved.startsWith(repoPrefix));
  if (invalidSource) {
    throw new Error(`Unsupported direct Dockerfile.base COPY source: ${relativePath}`);
  }
  if (matchesDockerignoreSecretPattern(relativePath)) {
    throw new Error(
      `Unsupported .dockerignore-secret Dockerfile.base COPY source: ${relativePath}`,
    );
  }
  return resolved;
}

function copyOldBaseContextFile(buildContext: string, relativePath: string): void {
  const source = validateOldBaseContextSource(relativePath);
  const target = path.join(buildContext, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

export function createOldBaseBuildContext(): string {
  const buildContext = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-rebuild-openclaw-base-"));
  // The legacy bash test builds Dockerfile.base with the full repository as
  // context after temporarily lowering blueprint.yaml in-place. Keep the
  // trusted checkout read-only while staging every current Dockerfile.base
  // direct COPY dependency needed by that old-base build.
  for (const relativePath of oldBaseContextSources()) {
    copyOldBaseContextFile(buildContext, relativePath);
  }

  const stagedBlueprint = path.join(buildContext, ...BLUEPRINT_RELPATH.split("/"));
  const original = fs.readFileSync(stagedBlueprint, "utf8");
  const minOpenClawVersion = /^(\s*min_openclaw_version:\s*).*/m;
  if (!minOpenClawVersion.test(original)) {
    throw new Error("blueprint min_openclaw_version line was not found");
  }
  const lowered = original.replace(minOpenClawVersion, `$1"${OLD_OPENCLAW_VERSION}"`);
  fs.writeFileSync(stagedBlueprint, lowered, "utf8");
  return buildContext;
}

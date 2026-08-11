// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { AGENT_ID_PATTERN } from "../../src/lib/actions/sandbox/sessions/paths";

const FLAG_ID = new RegExp(String.raw`--agent(?:=|\s+)(${AGENT_ID_PATTERN})`, "g");
const CANONICAL_KEY_ID = new RegExp(String.raw`\bagent:(${AGENT_ID_PATTERN}):`, "g");
const HERMES_ALIAS = "hermes";

type Usage = { id: string; line: number; text: string };

interface CommandWithExamples {
  examples: readonly string[];
  id: string;
}

export interface DocumentationAgentIdAudit {
  commandReferenceOffenders: string[];
  otherPageOffenders: string[];
}

function allowedIds(variant: string, bakedAgentIds: string[]): Set<string> {
  if (variant === HERMES_ALIAS) {
    return new Set([HERMES_ALIAS]);
  }
  if (variant === "any") {
    return new Set([...bakedAgentIds, HERMES_ALIAS]);
  }
  return new Set(bakedAgentIds);
}

function collectIds(text: string): string[] {
  return [FLAG_ID, CANONICAL_KEY_ID].flatMap((pattern) =>
    Array.from(text.matchAll(pattern), (match) => match[1] as string),
  );
}

function scanDoc(file: string): Map<string, Usage[]> {
  const byVariant = new Map<string, Usage[]>();
  const variants: string[] = [];
  let activeFence: { length: number; marker: "`" | "~" } | null = null;

  fs.readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, index) => {
      const opened = /<AgentOnly\s+variant="([a-z-]+)"/.exec(line);
      if (opened) {
        variants.push(opened[1] as string);
        return;
      }
      if (line.includes("</AgentOnly>")) {
        variants.pop();
        return;
      }
      const fence = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
      if (!activeFence && fence) {
        const delimiter = fence[1] as string;
        activeFence = {
          length: delimiter.length,
          marker: delimiter[0] as "`" | "~",
        };
        return;
      }
      if (activeFence && fence) {
        const delimiter = fence[1] as string;
        const closesFence =
          delimiter[0] === activeFence.marker &&
          delimiter.length >= activeFence.length &&
          (fence[2] as string).trim().length === 0;
        if (closesFence) {
          activeFence = null;
          return;
        }
      }
      if (!activeFence || line.includes(" onboard ")) {
        return;
      }
      const variant = variants.at(-1) ?? "any";
      for (const id of collectIds(line)) {
        const usages = byVariant.get(variant) ?? [];
        usages.push({ id, line: index + 1, text: line.trim() });
        byVariant.set(variant, usages);
      }
    });

  return byVariant;
}

function docFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return entry.name === "_build" ? [] : docFiles(full);
      }
      return /\.mdx?$/.test(entry.name) ? [full] : [];
    })
    .sort();
}

function docOffenders(
  file: string,
  docsRoot: string,
  bakedAgentIds: string[],
  includeVariant: boolean,
): string[] {
  const offenders: string[] = [];
  for (const [variant, usages] of scanDoc(file)) {
    const allowed = allowedIds(variant, bakedAgentIds);
    for (const usage of usages) {
      if (!allowed.has(usage.id)) {
        const location = `${path.relative(docsRoot, file)}:${usage.line}`;
        const variantSuffix = includeVariant ? ` (${variant})` : "";
        offenders.push(`${location}${variantSuffix} -> ${usage.text}`);
      }
    }
  }
  return offenders;
}

export function auditDocumentationAgentIds(
  docsRoot: string,
  commandReference: string,
  bakedAgentIds: string[],
): DocumentationAgentIdAudit {
  return {
    commandReferenceOffenders: docOffenders(commandReference, docsRoot, bakedAgentIds, true),
    otherPageOffenders: docFiles(docsRoot)
      .filter((file) => file !== commandReference)
      .flatMap((file) => docOffenders(file, docsRoot, bakedAgentIds, false)),
  };
}

export function auditCommandExampleAgentIds(
  commands: readonly CommandWithExamples[],
  bakedAgentIds: string[],
): string[] {
  const allowed = new Set(bakedAgentIds);
  const offenders: string[] = [];
  for (const command of commands) {
    for (const example of command.examples) {
      for (const id of collectIds(example)) {
        if (!allowed.has(id)) {
          offenders.push(`${command.id}: ${example}`);
        }
      }
    }
  }
  return offenders;
}

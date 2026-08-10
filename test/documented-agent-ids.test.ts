// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildConfig } from "../scripts/generate-openclaw-config.mts";
import SandboxAgentCommand from "../src/commands/sandbox/agent";
import SandboxSessionsDeleteCommand from "../src/commands/sandbox/sessions/delete";
import SandboxSessionsExportCommand from "../src/commands/sandbox/sessions/export";
import SandboxSessionsListCommand from "../src/commands/sandbox/sessions/list";
import SandboxSessionsResetCommand from "../src/commands/sandbox/sessions/reset";
import { baseOpenClawGenerationEnv, buildOpenClawTestEnv } from "./helpers/openclaw-env-fixture";

const DOCS_ROOT = path.join(import.meta.dirname, "..", "docs");
const COMMANDS_DOC = path.join(DOCS_ROOT, "reference", "commands.mdx");

const FLAG_ID = /--agent(?:=|\s+)([a-z][a-z0-9_-]*)/g;
const CANONICAL_KEY_ID = /\bagent:([a-z][a-z0-9_-]*):/g;

const HERMES_ALIAS = "hermes";

type Usage = { id: string; line: number; text: string };

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
  const ids: string[] = [];
  for (const pattern of [FLAG_ID, CANONICAL_KEY_ID]) {
    pattern.lastIndex = 0;
    let match = pattern.exec(text);
    while (match) {
      ids.push(match[1] as string);
      match = pattern.exec(text);
    }
  }
  return ids;
}

function scanDoc(file: string): Map<string, Usage[]> {
  const byVariant = new Map<string, Usage[]>();
  const variants: string[] = [];
  let inFence = false;

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
      if (line.trimStart().startsWith("```")) {
        inFence = !inFence;
        return;
      }
      if (!inFence || line.includes(" onboard ")) {
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

describe("agent ids in NemoClaw documentation and CLI examples (#8706)", () => {
  let tmpDir: string;
  let bakedAgentIds: string[];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "documented-agent-ids-"));
    const env = buildOpenClawTestEnv(tmpDir, baseOpenClawGenerationEnv());
    const config = buildConfig(env) as {
      agents: { list: Array<{ id: string }> };
    };
    bakedAgentIds = config.agents.list.map((entry) => entry.id);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("bakes exactly one agent id when onboarding declares no extra agents", () => {
    expect(bakedAgentIds).toEqual(["main"]);
  });

  it("restricts the command reference examples to baked agent ids", () => {
    const offenders: string[] = [];

    for (const [variant, usages] of scanDoc(COMMANDS_DOC)) {
      const allowed = allowedIds(variant, bakedAgentIds);
      for (const usage of usages) {
        if (!allowed.has(usage.id)) {
          offenders.push(`commands.mdx:${usage.line} (${variant}) -> ${usage.text}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("restricts every documentation page outside the command reference to baked agent ids", () => {
    const offenders: string[] = [];

    for (const file of docFiles(DOCS_ROOT)) {
      if (file === COMMANDS_DOC) {
        continue;
      }
      for (const [variant, usages] of scanDoc(file)) {
        const allowed = allowedIds(variant, bakedAgentIds);
        for (const usage of usages) {
          if (!allowed.has(usage.id)) {
            offenders.push(`${path.relative(DOCS_ROOT, file)}:${usage.line} -> ${usage.text}`);
          }
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("restricts the sandbox command examples to baked agent ids", () => {
    const commands = [
      SandboxAgentCommand,
      SandboxSessionsListCommand,
      SandboxSessionsResetCommand,
      SandboxSessionsDeleteCommand,
      SandboxSessionsExportCommand,
    ];
    const allowed = new Set(bakedAgentIds);
    const offenders: string[] = [];

    for (const command of commands) {
      for (const example of command.examples as string[]) {
        for (const id of collectIds(example)) {
          if (!allowed.has(id)) {
            offenders.push(`${command.id}: ${example}`);
          }
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

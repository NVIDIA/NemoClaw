// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(repoRoot, "docs/reference/commands.mdx");
const targetPath = path.join(repoRoot, "docs/reference/commands-nemohermes.mdx");

const GENERATED_NOTICE =
  "{/* This file is generated from docs/reference/commands.mdx by scripts/sync-agent-variant-docs.ts. Run `npm run docs:sync-agent-variants` to regenerate it. Do not edit by hand. */}";

const checkOnly = process.argv.includes("--check");

function main(): void {
  const source = readFileSync(sourcePath, "utf8");
  const rendered = renderHermesCommandsReference(source);
  const existing = readOptionalTarget();

  if (checkOnly) {
    if (existing !== rendered) {
      console.error(
        "docs/reference/commands-nemohermes.mdx is out of sync. Run `npm run docs:sync-agent-variants`.",
      );
      process.exit(1);
    }
    return;
  }

  if (existing !== rendered) {
    writeFileSync(targetPath, rendered);
    console.log(`Wrote ${path.relative(repoRoot, targetPath)}`);
  } else {
    console.log(`${path.relative(repoRoot, targetPath)} is already up to date`);
  }
}

export function renderHermesCommandsReference(source: string): string {
  const { frontmatter, body } = splitFrontmatter(source);
  const hermesFrontmatter = updateFrontmatter(frontmatter);
  const hermesBody = transformNemoclawCliInvocations(
    stripAgentOnlyBlocks(body).replace(
      /^import \{ AgentOnly \} from "\.\.\/_components\/AgentGuide";\n\n?/m,
      "",
    ),
  )
    .replace(/\n{3,}/g, "\n\n")
    .trimStart();

  return `${hermesFrontmatter}${GENERATED_NOTICE}\n\n${hermesBody}`.replace(/\s*$/, "\n");
}

function splitFrontmatter(source: string): { frontmatter: string; body: string } {
  const match = source.match(/^(---\n[\s\S]*?\n---\n)([\s\S]*)$/);
  if (!match) {
    throw new Error("commands.mdx must start with YAML frontmatter");
  }
  return { frontmatter: match[1], body: match[2] };
}

function updateFrontmatter(frontmatter: string): string {
  let next = frontmatter;
  next = replaceFrontmatterLine(next, "title", '"NemoHermes CLI Commands Reference"');
  next = replaceFrontmatterLine(next, "sidebar-title", '"Commands"');
  next = replaceFrontmatterLine(
    next,
    "description",
    '"Full CLI reference for standalone NemoHermes commands and Hermes-specific in-sandbox commands."',
  );
  next = replaceFrontmatterLine(
    next,
    "description-agent",
    '"Includes the full CLI reference for standalone NemoHermes commands and Hermes-specific in-sandbox commands. Use when looking up a specific `nemohermes` subcommand, flag, argument, or exit code."',
  );
  next = replaceFrontmatterLine(
    next,
    "keywords",
    '["nemohermes cli commands", "hermes command reference", "nemohermes command reference"]',
  );
  return next;
}

function replaceFrontmatterLine(frontmatter: string, key: string, value: string): string {
  const pattern = new RegExp(`^${escapeRegExp(key)}:.*$`, "m");
  if (!pattern.test(frontmatter)) {
    throw new Error(`commands.mdx frontmatter is missing '${key}'`);
  }
  return frontmatter.replace(pattern, `${key}: ${value}`);
}

function stripAgentOnlyBlocks(body: string): string {
  return body.replace(
    /\n?<AgentOnly variant="(openclaw|hermes)">\n([\s\S]*?)\n<\/AgentOnly>\n?/g,
    (_match, variant: string, content: string) => {
      if (variant !== "hermes") return "\n";
      return `\n${content.trim()}\n`;
    },
  );
}

function transformNemoclawCliInvocations(body: string): string {
  return restoreProtectedLiterals(
    protectNonAliasableLiterals(body)
      // Inline code and headings that start with the host CLI command.
      .replace(/`nemoclaw(?=[\s`])/g, "`nemohermes")
      // Copyable shell examples, including env-prefixed invocations and
      // continuation lines indented under a previous shell command.
      .replace(
        /^(\s*(?:\$ )?(?:(?:[A-Z_][A-Z0-9_]*=[^\s\\]+|export)\s+)*)(nemoclaw)(?=\s|$)/gm,
        "$1nemohermes",
      )
      // Shell command substitutions used in examples.
      .replace(/\$\(nemoclaw(?=\s|\))/g, "$(nemohermes")
      // Same-page anchors generated from command headings.
      .replace(/#nemoclaw(?=[-)])/g, "#nemohermes"),
  );
}

const PROTECTED_LITERALS = [
  ["nemoclaw onboard --agent hermes", "__NEMOCLAW_ONBOARD_AGENT_HERMES__"],
] as const;

function protectNonAliasableLiterals(body: string): string {
  return PROTECTED_LITERALS.reduce(
    (next, [literal, token]) => next.replaceAll(literal, token),
    body,
  );
}

function restoreProtectedLiterals(body: string): string {
  return PROTECTED_LITERALS.reduce(
    (next, [literal, token]) => next.replaceAll(token, literal),
    body,
  );
}

function readOptionalTarget(): string | null {
  try {
    return readFileSync(targetPath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main();
}

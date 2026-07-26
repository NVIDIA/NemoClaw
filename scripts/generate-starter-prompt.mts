// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const STARTER_PROMPT_SOURCE_PATH = "docs/resources/starter-prompt.md";
export const STARTER_PROMPT_GENERATED_PATH = "docs/_build/StarterPrompt.generated.mdx";

const MARKDOWN_SPDX_HEADER =
  /^<!--\n  SPDX-FileCopyrightText: [^\n]+\n  SPDX-License-Identifier: Apache-2\.0\n-->\n\n/;
const GENERATED_NOTICE =
  "Generated from docs/resources/starter-prompt.md by scripts/generate-starter-prompt.mts. Do not edit.";

export function extractStarterPromptMarkdown(source: string, relativePath: string): string {
  if (source.includes("\r")) {
    throw new Error(`${relativePath}: use LF line endings`);
  }

  const header = source.match(MARKDOWN_SPDX_HEADER)?.[0];
  if (!header) {
    throw new Error(`${relativePath}: expected the standard Markdown SPDX header`);
  }

  const prompt = source.slice(header.length);
  if (!prompt.startsWith("# NemoClaw Instructions for a Non-Technical User\n")) {
    throw new Error(`${relativePath}: prompt must start with the canonical heading`);
  }
  if (!prompt.endsWith("\n") || prompt.endsWith("\n\n")) {
    throw new Error(`${relativePath}: prompt must end with exactly one newline`);
  }

  return prompt.slice(0, -1);
}

export function renderStarterPromptSnippet(prompt: string): string {
  return `{/*
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
*/}

{/* ${GENERATED_NOTICE} */}

<Prompt
  title="Install NemoClaw with your coding agent"
>
${prompt}
</Prompt>
`;
}

export function generateStarterPromptSnippet(): string {
  const source = readFileSync(path.join(REPO_ROOT, STARTER_PROMPT_SOURCE_PATH), "utf8");
  const prompt = extractStarterPromptMarkdown(source, STARTER_PROMPT_SOURCE_PATH);
  return renderStarterPromptSnippet(prompt);
}

type StarterPromptGeneratorOptions = {
  args?: string[];
  generatedPath?: string;
  log?: (message: string) => void;
  reportError?: (message: string) => void;
};

function readGeneratedSnippet(generatedPath: string): string {
  try {
    return readFileSync(generatedPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return "";
  }
}

export function runStarterPromptGenerator({
  args = process.argv.slice(2),
  generatedPath = path.join(REPO_ROOT, STARTER_PROMPT_GENERATED_PATH),
  log = console.log,
  reportError = console.error,
}: StarterPromptGeneratorOptions = {}): number {
  const unexpectedArgs = args.filter((arg) => arg !== "--check");
  if (unexpectedArgs.length > 0) {
    throw new Error(`Unknown arguments: ${unexpectedArgs.join(", ")}`);
  }

  const expected = generateStarterPromptSnippet();

  if (args.includes("--check")) {
    const actual = readGeneratedSnippet(generatedPath);
    if (actual !== expected) {
      reportError(
        `${STARTER_PROMPT_GENERATED_PATH} is missing or stale. Run npm run docs:sync-starter-prompt.`,
      );
      return 1;
    }
    log("Generated Starter Prompt snippet is current.");
    return 0;
  }

  mkdirSync(path.dirname(generatedPath), { recursive: true });
  writeFileSync(generatedPath, expected);
  log(`Generated ${STARTER_PROMPT_GENERATED_PATH}.`);
  return 0;
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  process.exitCode = runStarterPromptGenerator();
}

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { longSetupPrompt } from "../test/runtime-context-path-prompts.js";

const classifierUrl = new URL("./runtime-context.ts", import.meta.url).href;
const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const nestedLocalTarget = "contents of ".repeat(129) + "README.md";

it.each([
  ...[
    {
      name: "bounds repeated quoted research topics",
      prompt: `Search for ${'"official docs on docs.nvidia.com" '.repeat(64)}`,
    },
    {
      name: "bounds a long quoted research topic",
      prompt: `Search for "${"guide ".repeat(640)}docs.nvidia.com"`,
    },
    {
      name: "bounds the reported whitespace-heavy input",
      prompt: "Search bug" + " ".repeat(32000) + "outside",
    },
    {
      name: "bounds doubled whitespace-heavy input",
      prompt: "Search bug" + " ".repeat(64000) + "outside",
    },
    {
      name: "bounds whitespace-heavy input at the input length limit",
      prompt: "Search bug".padEnd(4089) + "outside",
    },
    {
      name: "bounds mixed Unicode whitespace",
      prompt: "Search bug" + "\t\u2003\u00a0".repeat(12000) + "outside",
    },
    {
      name: "rejects a local target above the input length limit",
      prompt: "Search README.md".padEnd(4097),
    },
    {
      name: "rejects oversized ordinary work",
      prompt: "Explain " + "x".repeat(8192),
    },
    { name: "rejects oversized whitespace before trimming", prompt: " ".repeat(4097) },
    {
      name: "revokes earlier URL grants on input length overflow",
      prompt: "Read https://example.org/guide. " + "Search README.md".padEnd(4097),
    },
    {
      name: "rejects a long prompt whose later paragraph asks for web research",
      prompt: `${longSetupPrompt}Search the web for today's news.`,
    },
    {
      name: "rejects an unbroken line above the window limit inside a long prompt",
      prompt: `${longSetupPrompt}${"x".repeat(1025)}`,
    },
    {
      name: "bounds whitespace-heavy windows in a long prompt",
      prompt: ("Search bug".padEnd(1000) + "outside\n").repeat(16),
    },
    {
      name: "rejects a prompt above the total input length limit",
      prompt: "Read README.md.\n".repeat(1025),
    },
    {
      name: "bounds the reported deeply nested relationship input",
      prompt: "Search " + "contents of ".repeat(4000) + "README.md",
    },
    { name: "bounds nested relationships", prompt: `Search ${nestedLocalTarget}` },
    {
      name: "denies ordinary work when parsing is exhausted",
      prompt: `Explain ${nestedLocalTarget}`,
    },
    {
      name: "revokes earlier URL grants when parsing is exhausted",
      prompt: `Read https://example.org/guide. Search ${nestedLocalTarget}`,
    },
    {
      name: "bounds relationships in source locations",
      prompt: `Search for TODOs in ${nestedLocalTarget}`,
    },
    {
      name: "bounds nested diagnostic causes",
      prompt: `Investigate ${"cause of ".repeat(129)}npm install errors`,
    },
    {
      name: "shares work across resource operands",
      prompt: `Search ${"README.md and ".repeat(256)}package.json`,
    },
    {
      name: "rejects a long prompt with a nested target above the window limit",
      prompt: `${longSetupPrompt}Search ${nestedLocalTarget}`,
    },
    {
      // About 800 characters: it fits one window, so only the work budget can stop it.
      name: "denies a long prompt when one window exhausts parsing",
      prompt: `${longSetupPrompt}Search ${"a.md, ".repeat(160)}README.md`,
    },
  ].map((row) => ({ ...row, expected: { scope: "external", local: false, urls: [] } })),
  ...[
    {
      name: "retains local work at the input length limit",
      prompt: "Search README.md".padEnd(4096),
    },
    {
      name: "retains shallow nested relationships",
      prompt: `Search ${"contents of ".repeat(8)}README.md`,
    },
    {
      name: "retains queries on nested relationships",
      prompt: `Search ${"contents of ".repeat(4)}README.md for TODOs`,
    },
    {
      name: "retains shallow resource locations",
      prompt: `Search ${"contents of ".repeat(4)}README.md in this directory`,
    },
    {
      name: "retains ordinary coordinated resource lists",
      prompt: `Search ${"README.md and ".repeat(8)}package.json`,
    },
    { name: "retains ordinary request clauses", prompt: "Read README.md. ".repeat(8) },
    {
      name: "retains request clauses that span several windows",
      prompt: "Read README.md. ".repeat(256),
    },
    {
      name: "retains local work in a prompt past the input length limit (#14309)",
      prompt: longSetupPrompt,
    },
    {
      name: "retains lines at the window limit without counting their line breaks",
      prompt: ("Read README.md".padEnd(1024) + "\n").repeat(5),
    },
    {
      name: "retains local work in a prompt near the total input length limit",
      prompt: "Read README.md.\n".repeat(1024),
    },
  ].map((row) => ({ ...row, expected: { scope: "supplied", local: true, urls: [] } })),
  {
    name: "retains missing prompt handling at the input length limit",
    prompt: " ".repeat(4096),
    expected: { scope: "missing", local: false, urls: [] },
  },
  {
    // The window boundary falls between the instruction and its indented URL.
    name: "keeps an indented URL with its instruction in a long prompt",
    prompt:
      "Read README.md.\n".repeat(60) +
      "Browse the web using web_fetch at this URL:\n  HTTPS://example.org/guide",
    expected: { scope: "supplied", local: true, urls: ["HTTPS://example.org/guide"] },
  },
  {
    // The window boundary falls between "Search and" and the verb it coordinates.
    name: "keeps coordinated verbs with their target in a long prompt",
    prompt: "Read README.md.\n".repeat(63) + "Search and\nread README.md.",
    expected: { scope: "supplied", local: true, urls: [] },
  },
  {
    name: "keeps a coordinator that starts the next line with its verb in a long prompt",
    prompt: "Read README.md.\n".repeat(63) + "Search\nand read README.md.",
    expected: { scope: "supplied", local: true, urls: [] },
  },
  {
    // Each window edge falls at the line break, as in a whole-prompt parse.
    name: "rejects external research that continues after a line break in a long prompt",
    prompt: "Read README.md.\n".repeat(63) + "Search\n the web for current news",
    expected: { scope: "external", local: false, urls: [] },
  },
  {
    name: "rejects a local request continued by external research on the next line",
    prompt:
      "Read README.md.\n".repeat(62) +
      "Search README.md\nfor the latest installation documentation online.",
    expected: { scope: "external", local: false, urls: [] },
  },
  {
    name: "rejects a long line break run that would form its own window",
    prompt: `${longSetupPrompt}Read README.md.${"\n".repeat(1025)}Read README.md.`,
    expected: { scope: "external", local: false, urls: [] },
  },
  {
    name: "retains shallow diagnostic causes",
    prompt: `Investigate ${"cause of ".repeat(8)}npm install errors`,
    expected: { scope: "ordinary", local: false, urls: [] },
  },
  {
    name: "rejects a nonlocal tail after repeated singular source qualifiers",
    prompt: `Search bug\t${"source\t".repeat(128)}outside`,
    expected: { scope: "external", local: false, urls: [] },
  },
  {
    name: "retains a local target with repeated singular source qualifiers",
    prompt: `Search bug\t${"source\t".repeat(128)}`,
    expected: { scope: "supplied", local: true, urls: [] },
  },
  {
    name: "rejects a nonlocal tail after repeated plural source qualifiers",
    prompt: `Search bug\t${"sources\t".repeat(128)}outside`,
    expected: { scope: "external", local: false, urls: [] },
  },
  {
    name: "retains a local target with repeated plural source qualifiers",
    prompt: `Search bug\t${"sources\t".repeat(128)}`,
    expected: { scope: "supplied", local: true, urls: [] },
  },
])(
  "$name within the classification deadline (#13594)",
  ({ prompt, expected }) => {
    // A subprocess deadline can stop synchronous regex backtracking; a test timer cannot.
    const output = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `import { readFileSync } from "node:fs";
         import { classifySearchTurn } from ${JSON.stringify(classifierUrl)};
         process.stdout.write(JSON.stringify([
           classifySearchTurn(JSON.parse(readFileSync(0, "utf8"))),
           classifySearchTurn("Search README.md")
         ]));`,
      ],
      { cwd: repositoryRoot, encoding: "utf8", input: JSON.stringify(prompt), timeout: 3_000 },
    );
    expect(JSON.parse(output)).toEqual([expected, { scope: "supplied", local: true, urls: [] }]);
  },
  15_000,
);

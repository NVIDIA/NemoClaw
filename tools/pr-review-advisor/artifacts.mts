// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

type ArtifactContextToolResult = {
  toolName: string;
  label?: string;
  content: string;
  contentType: string;
};

type ArtifactPromptTurn = {
  name: string;
  prompt: string;
  contextToolResults?: ArtifactContextToolResult[];
};

type ArtifactCompletedTurn = {
  index: number;
  total: number;
  name: string;
  text: string;
  status: string;
  error?: string;
};

export type ArtifactPaths = {
  promptDir: string;
  turnDir: string;
  contextDir: string;
  raw: string;
  result: string;
  finalResult: string;
  findingLedger: string;
  terminologyLedger: string;
  summary: string;
  sessionHtml: string;
};

export function artifactPaths(outDir: string): ArtifactPaths {
  return {
    promptDir: path.join(outDir, "prompts"),
    turnDir: path.join(outDir, "turns"),
    contextDir: path.join(outDir, "context"),
    raw: path.join(outDir, "pr-review-advisor-raw-output.txt"),
    result: path.join(outDir, "pr-review-advisor-result.json"),
    finalResult: path.join(outDir, "pr-review-advisor-final-result.json"),
    findingLedger: path.join(outDir, "pr-review-advisor-finding-ledger.json"),
    terminologyLedger: path.join(outDir, "pr-review-advisor-terminology-ledger.json"),
    summary: path.join(outDir, "pr-review-advisor-summary.md"),
    sessionHtml: path.join(outDir, "pr-review-advisor-session.html"),
  };
}

export function writePromptArtifacts({
  promptDir,
  systemPrompt,
  promptTurns,
}: {
  promptDir: string;
  systemPrompt: string;
  promptTurns: ArtifactPromptTurn[];
}): void {
  fs.rmSync(promptDir, { recursive: true, force: true });
  fs.mkdirSync(promptDir, { recursive: true });

  const systemPromptPath = path.join(promptDir, "00-system.md");
  fs.writeFileSync(systemPromptPath, `${systemPrompt.trimEnd()}\n`);

  for (const [index, turn] of promptTurns.entries()) {
    const ordinal = String(index + 1).padStart(2, "0");
    const turnSlug = promptArtifactSlug(turn.name);
    const fileName = `${ordinal}-${turnSlug}.md`;
    const filePath = path.join(promptDir, fileName);
    fs.writeFileSync(filePath, `${turn.prompt.trimEnd()}\n`);

    if (turn.contextToolResults && turn.contextToolResults.length > 0) {
      const toolResultDir = path.join(promptDir, `${ordinal}-${turnSlug}.tool-results`);
      fs.mkdirSync(toolResultDir, { recursive: true });
      for (const [toolIndex, result] of turn.contextToolResults.entries()) {
        const resultOrdinal = String(toolIndex + 1).padStart(2, "0");
        const resultName = result.label || result.toolName;
        const resultSlug = promptArtifactSlug(resultName);
        const resultPath = path.join(toolResultDir, `${resultOrdinal}-${resultSlug}.md`);
        fs.writeFileSync(resultPath, contextToolResultArtifact(result));
      }
    }
  }
}

export function writeTurnArtifact(turnDir: string, turn: ArtifactCompletedTurn): string {
  fs.mkdirSync(turnDir, { recursive: true });
  const ordinal = String(turn.index).padStart(2, "0");
  const filePath = path.join(turnDir, `${ordinal}-${promptArtifactSlug(turn.name)}.txt`);
  const header = [
    `turn: ${turn.index}/${turn.total}`,
    `name: ${turn.name}`,
    `status: ${turn.status}`,
    turn.error ? `error: ${turn.error.trim().replace(/\s+/g, " ")}` : undefined,
    "--- ASSISTANT TEXT ---",
  ].filter((line): line is string => line !== undefined);
  fs.writeFileSync(filePath, `${header.join("\n")}\n${turn.text.trimEnd()}\n`);
  return filePath;
}

function contextToolResultArtifact(result: ArtifactContextToolResult): string {
  return [
    `# Context tool result: ${result.label || result.toolName}`,
    "",
    `- toolName: ${result.toolName}`,
    result.label ? `- label: ${result.label}` : undefined,
    `- contentType: ${result.contentType}`,
    "",
    fencedBlock(result.content, result.contentType),
    "",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function promptArtifactSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9._-]/g, "")
      .slice(0, 80) || "turn"
  );
}

function fencedBlock(content: string, language = ""): string {
  const longestBacktickRun = Math.max(
    0,
    ...Array.from(content.matchAll(/`+/g), (match) => match[0]?.length ?? 0),
  );
  const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
  return `${fence}${language}\n${content}\n${fence}`;
}

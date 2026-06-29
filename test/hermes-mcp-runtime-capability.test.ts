// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
const HERMES_DOCKERFILE = path.join(ROOT, "agents", "hermes", "Dockerfile");

function dockerRunCommandBetween(
  dockerfile: string,
  startMarker: string,
  endMarker: string,
): string {
  const start = dockerfile.indexOf(startMarker);
  const end = dockerfile.indexOf(endMarker, start);
  expect(start, `Expected Dockerfile start marker ${startMarker}`).toBeGreaterThanOrEqual(0);
  expect(end, `Expected Dockerfile end marker ${endMarker}`).toBeGreaterThan(start);
  const runIndex = dockerfile.indexOf("RUN ", start);
  expect(runIndex, `Expected RUN instruction after ${startMarker}`).toBeGreaterThanOrEqual(start);
  expect(runIndex, `Expected RUN instruction before ${endMarker}`).toBeLessThan(end);
  const blockLines = dockerfile.slice(runIndex, end).split("\n");
  const runEnd = blockLines.findIndex((line) => !line.trimEnd().endsWith("\\"));
  expect(runEnd, `Expected complete RUN instruction before ${endMarker}`).toBeGreaterThanOrEqual(0);
  const runLines = blockLines.slice(0, runEnd + 1);
  return runLines
    .join("\n")
    .trim()
    .replace(/^RUN\s+/, "")
    .replace(/\\\n/g, " ");
}

function runHermesMcpClientImportValidation({
  mcpAvailable,
  httpAvailable,
}: {
  mcpAvailable: boolean;
  httpAvailable: boolean;
}) {
  const dockerfile = fs.readFileSync(HERMES_DOCKERFILE, "utf-8");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-mcp-runtime-"));
  const toolsDir = path.join(tmp, "tools");
  const command = dockerRunCommandBetween(
    dockerfile,
    "# Managed MCP requires the packaged Hermes client surface",
    "# Published base images can lag Dockerfile.base",
  ).replaceAll("/opt/hermes/.venv/bin/python", "python3");
  try {
    fs.mkdirSync(toolsDir, { recursive: true });
    fs.writeFileSync(path.join(tmp, "mcp.py"), "# MCP SDK fixture\n");
    fs.writeFileSync(path.join(toolsDir, "__init__.py"), "");
    fs.writeFileSync(
      path.join(toolsDir, "mcp_tool.py"),
      `_MCP_AVAILABLE = ${mcpAvailable ? "True" : "False"}\n` +
        `_MCP_HTTP_AVAILABLE = ${httpAvailable ? "True" : "False"}\n`,
    );
    return spawnSync("bash", ["-c", command], {
      encoding: "utf-8",
      env: { ...process.env, PYTHONPATH: tmp },
      timeout: 5000,
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

describe("Hermes managed MCP client import capability", () => {
  it("fails the final image build without packaged Streamable HTTP client support", () => {
    const complete = runHermesMcpClientImportValidation({
      mcpAvailable: true,
      httpAvailable: true,
    });
    expect(complete.status, complete.stderr).toBe(0);

    const missingHttp = runHermesMcpClientImportValidation({
      mcpAvailable: true,
      httpAvailable: false,
    });
    expect(missingHttp.status).toBe(1);
    expect(missingHttp.stderr).toContain("Hermes MCP Streamable HTTP runtime is unavailable");
  });
});

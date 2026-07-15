// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "benchmark-sandbox-image-build.mts");

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function runScript(args: string[]): Promise<RunResult> {
  const child = spawn(process.execPath, ["--import", "tsx", SCRIPT, ...args], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const [code] = (await once(child, "close")) as [number | null];
  return { code, stdout, stderr };
}

describe("sandbox image build benchmark", () => {
  it("loads the compiled build-context import and rejects an unknown flag before any build (#6923)", async () => {
    const result = await runScript(["--not-a-real-flag"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Unknown argument: --not-a-real-flag");
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("does not provide an export");
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("Cannot find module");
  });
});

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const packageScript = path.join(root, "scripts/package-pr-review-advisor-runtime.sh");
const restoreScript = path.join(root, "scripts/restore-pr-review-advisor-runtime.sh");

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "advisor-runtime-"));
  const advisor = path.join(directory, "advisor");
  const bin = path.join(directory, "bin");
  fs.mkdirSync(path.join(advisor, "node_modules", "package"), { recursive: true });
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(advisor, "node_modules", "package", "index.js"), "export {};\n");
  for (const name of ["rg", "fdfind"])
    fs.writeFileSync(path.join(bin, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return { directory, advisor, bin };
}

function environment(input: ReturnType<typeof fixture>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ADVISOR_DIR: input.advisor,
    GITHUB_WORKFLOW_SHA: "a".repeat(40),
    GITHUB_RUN_ID: "1234",
    GITHUB_RUN_ATTEMPT: "2",
    RUNNER_TEMP: input.directory,
    GITHUB_PATH: path.join(input.directory, "github-path"),
    PATH: `${input.bin}:${process.env.PATH ?? ""}`,
  };
}

describe("PR Review Advisor runtime artifact", () => {
  it("packages and restores the trusted runtime", () => {
    const input = fixture();
    const env = environment(input);
    const artifact = path.join(input.directory, "artifact");
    execFileSync(packageScript, [artifact], { env });
    fs.rmSync(path.join(input.advisor, "node_modules"), { recursive: true });
    env.EXPECTED_RUNTIME_SHA = fs
      .readFileSync(path.join(artifact, "runtime.sha256"), "utf8")
      .trim();
    execFileSync(restoreScript, [artifact], { env });
    expect(fs.readFileSync(path.join(input.advisor, "node_modules/package/index.js"), "utf8")).toBe(
      "export {};\n",
    );
    expect(fs.readFileSync(env.GITHUB_PATH as string, "utf8")).toContain("pr-review-advisor-runtime-bin");
  });

  it("rejects a payload whose digest changed", () => {
    const input = fixture();
    const env = environment(input);
    const artifact = path.join(input.directory, "artifact");
    execFileSync(packageScript, [artifact], { env });
    fs.rmSync(path.join(input.advisor, "node_modules"), { recursive: true });
    env.EXPECTED_RUNTIME_SHA = "0".repeat(64);
    expect(() => execFileSync(restoreScript, [artifact], { env })).toThrow();
    expect(fs.existsSync(path.join(input.advisor, "node_modules"))).toBe(false);
  });
});

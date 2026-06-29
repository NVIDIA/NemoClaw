// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { expect, test } from "../fixtures/e2e-test.ts";
import { shouldRunLiveE2EScenarios } from "../fixtures/live-project-gate.ts";

// Migrated from test/e2e/test-docs-validation.sh. This checkout-local scenario
// keeps the old docs E2E phases, but runs them directly through Vitest instead
// of a legacy shell wrapper: CLI/docs parity, then local-only Markdown links.

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const CHECK_DOCS = path.join(REPO_ROOT, "test", "e2e", "e2e-cloud-experimental", "check-docs.sh");
const BUILD_TIMEOUT_MS = 120_000;
const DOCS_CHECK_TIMEOUT_MS = 120_000;
const runDocsValidationTest = shouldRunLiveE2EScenarios() ? test : test.skip;

function writeExecutable(target: string, contents: string): void {
  fs.writeFileSync(target, contents, { mode: 0o755 });
}

async function writeNemoclawPathShim(binDir: string): Promise<string> {
  await fsp.mkdir(binDir, { recursive: true });
  const shim = path.join(binDir, "nemoclaw");
  writeExecutable(
    shim,
    `#!/usr/bin/env bash
exec node ${JSON.stringify(path.join(REPO_ROOT, "bin", "nemoclaw.js"))} "$@"
`,
  );
  return shim;
}

async function listFiles(root: string, base = root): Promise<string[]> {
  const entries = await fsp.readdir(root, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        return listFiles(entryPath, base);
      }
      return [path.relative(base, entryPath)];
    }),
  );
  return files.flat();
}

async function expectNoStaleDistCommandOutputs(): Promise<void> {
  const sourceRoot = path.join(REPO_ROOT, "src", "commands");
  const distRoot = path.join(REPO_ROOT, "dist", "commands");
  const [sourceFiles, distFiles] = await Promise.all([listFiles(sourceRoot), listFiles(distRoot)]);
  const expectedDistCommands = new Set(
    sourceFiles
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
      .map((file) => file.replace(/\.ts$/, ".js")),
  );
  const staleDistCommands = distFiles
    .filter((file) => file.endsWith(".js") && !expectedDistCommands.has(file))
    .sort();

  expect(
    staleDistCommands,
    `stale compiled command file(s) under dist/commands:\n${staleDistCommands.join("\n")}`,
  ).toEqual([]);
}

runDocsValidationTest(
  "docs validation matches CLI help and local documentation links",
  { timeout: BUILD_TIMEOUT_MS + DOCS_CHECK_TIMEOUT_MS * 2 },
  async ({ artifacts, host }) => {
    await artifacts.writeJson("scenario.json", {
      id: "docs-validation",
      runner: "vitest",
      boundary: "checkout-local-docs-checks",
      migratedFrom: "test/e2e/test-docs-validation.sh",
      phases: ["cli-docs-parity", "local-markdown-links"],
    });

    const build = await host.command("npm", ["run", "build:cli"], {
      artifactName: "docs-validation-build-cli",
      cwd: REPO_ROOT,
      inheritEnv: true,
      timeoutMs: BUILD_TIMEOUT_MS,
    });
    expect(build.exitCode, `CLI build failed\n${build.stdout}${build.stderr}`).toBe(0);
    await expectNoStaleDistCommandOutputs();

    const shimBin = artifacts.pathFor("bin");
    const homeDir = artifacts.pathFor("home");
    await fsp.mkdir(homeDir, { recursive: true });
    const shim = await writeNemoclawPathShim(shimBin);
    const env = {
      HOME: homeDir,
      PATH: `${shimBin}${path.delimiter}${process.env.PATH ?? ""}`,
      CHECK_DOC_LINKS_REMOTE: "0",
      NODE: process.execPath,
    };

    const prerequisite = await host.command(
      "bash",
      ["-lc", "command -v nemoclaw && nemoclaw --version"],
      {
        artifactName: "docs-validation-prerequisite",
        cwd: REPO_ROOT,
        inheritEnv: true,
        env,
        timeoutMs: DOCS_CHECK_TIMEOUT_MS,
      },
    );
    expect(
      prerequisite.exitCode,
      `nemoclaw PATH prerequisite failed\n${prerequisite.stdout}${prerequisite.stderr}`,
    ).toBe(0);
    const resolvedNemoclaw = prerequisite.stdout
      .split(/\r?\n/)
      .find((line) => line.trim().length > 0)
      ?.trim();
    expect(resolvedNemoclaw).toBe(shim);

    const cliParity = await host.command("bash", [CHECK_DOCS, "--only-cli"], {
      artifactName: "docs-validation-cli-parity",
      cwd: REPO_ROOT,
      inheritEnv: true,
      env,
      timeoutMs: DOCS_CHECK_TIMEOUT_MS,
    });
    expect(
      cliParity.exitCode,
      `CLI / docs parity failed\n${cliParity.stdout}${cliParity.stderr}`,
    ).toBe(0);
    expect(cliParity.stdout).toContain("check-docs: running: [cli]");
    expect(cliParity.stdout).toContain("command-level parity OK");

    const links = await host.command("bash", [CHECK_DOCS, "--only-links", "--local-only"], {
      artifactName: "docs-validation-local-links",
      cwd: REPO_ROOT,
      inheritEnv: true,
      env,
      timeoutMs: DOCS_CHECK_TIMEOUT_MS,
    });
    expect(links.exitCode, `Markdown link validation failed\n${links.stdout}${links.stderr}`).toBe(
      0,
    );
    expect(links.stdout).toContain("check-docs: running: [links]");
    expect(links.stdout).toContain("remote: skipped (local paths only)");
    expect(links.stdout).toContain("phase 2/2: skipped");
  },
);

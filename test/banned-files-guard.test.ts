// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "check-banned-files.mjs");
const TEMP_REPOS: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test User",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test User",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  }).trim();
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-banned-files-"));
  TEMP_REPOS.push(dir);
  git(dir, ["init", "-b", "main"]);
  fs.writeFileSync(path.join(dir, "README.md"), "# temp\n");
  git(dir, ["add", "README.md"]);
  git(dir, ["commit", "-m", "init"]);
  const base = git(dir, ["rev-parse", "HEAD"]);
  return { dir, base };
}

function runGuard(cwd: string, baseRef: string, headRef = "HEAD") {
  return spawnSync(process.execPath, [SCRIPT, baseRef, headRef], {
    cwd,
    encoding: "utf-8",
  });
}

afterEach(() => {
  for (const dir of TEMP_REPOS.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("banned-files guard", () => {
  it("fails when a banned secret-like file is added", () => {
    const { dir, base } = makeRepo();
    fs.writeFileSync(path.join(dir, ".env.production"), "API_KEY=secret\n");
    git(dir, ["add", ".env.production"]);
    git(dir, ["commit", "-m", "add env"]);

    const result = runGuard(dir, base);

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain(".env.production");
    expect(`${result.stdout}${result.stderr}`).toContain("API keys");
  });

  it("blocks additional secret-like patterns from the repo policy", () => {
    const cases = [
      ".netrc",
      ".npmrc",
      ".pypirc",
      ".direnv/credentials",
      "terraform/dev.tfvars",
      "keys/id_rsa",
      "keys/deploy_ed25519",
      "keys/build_ecdsa",
      "certs/release.keystore",
      "certs/debug.jks",
      "key.json",
      "token.json",
      "secrets.yaml",
      "secrets.json",
    ];

    for (const filePath of cases) {
      const { dir, base } = makeRepo();
      const fullPath = path.join(dir, filePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, "secret\n");
      git(dir, ["add", filePath]);
      git(dir, ["commit", "-m", `add ${filePath}`]);

      const result = runGuard(dir, base);
      expect(result.status, filePath).toBe(1);
      expect(`${result.stdout}${result.stderr}`, filePath).toContain(filePath);
    }
  });

  it("allows fixture files under test/fixtures", () => {
    const { dir, base } = makeRepo();
    fs.mkdirSync(path.join(dir, "test", "fixtures"), { recursive: true });
    fs.writeFileSync(path.join(dir, "test", "fixtures", "service-account-demo.json"), "{}\n");
    fs.mkdirSync(path.join(dir, "testdata", "keys"), { recursive: true });
    fs.writeFileSync(path.join(dir, "testdata", "keys", "id_rsa"), "fixture\n");
    git(dir, ["add", "test/fixtures/service-account-demo.json", "testdata/keys/id_rsa"]);
    git(dir, ["commit", "-m", "add fixture"]);

    const result = runGuard(dir, base);

    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("No banned files found");
  });

  it("passes when only normal source files change", () => {
    const { dir, base } = makeRepo();
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src", "index.ts"), "export const ok = true;\n");
    git(dir, ["add", "src/index.ts"]);
    git(dir, ["commit", "-m", "add source"]);

    const result = runGuard(dir, base);

    expect(result.status).toBe(0);
  });
});

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readYaml } from "./helpers/e2e-workflow-contract";

const repoRoot = path.join(import.meta.dirname, "..");
const scriptPath = path.join(repoRoot, "scripts", "release-lkg-brev-image.sh");
const tempRoots: string[] = [];

type WorkflowStep = {
  env?: Record<string, string>;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

type Workflow = {
  jobs: Record<
    string,
    {
      if?: string;
      steps?: WorkflowStep[];
    }
  >;
  on?: {
    push?: {
      tags?: string[];
    };
  };
  permissions?: Record<string, string>;
};

type Fixture = {
  argsPath: string;
  binDir: string;
  commit: string;
  inputPath: string;
  root: string;
  summaryPath: string;
  work: string;
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "LKG Dispatch Test",
      GIT_AUTHOR_EMAIL: "lkg-dispatch@example.com",
      GIT_COMMITTER_NAME: "LKG Dispatch Test",
      GIT_COMMITTER_EMAIL: "lkg-dispatch@example.com",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "tag.gpgSign",
      GIT_CONFIG_VALUE_0: "false",
    },
  }).trim();
}

function createFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-release-lkg-brev-image-"));
  tempRoots.push(root);
  const work = path.join(root, "work");
  const binDir = path.join(root, "bin");
  const argsPath = path.join(root, "gh-args.txt");
  const inputPath = path.join(root, "gh-input.json");
  const summaryPath = path.join(root, "summary.md");
  fs.mkdirSync(work);
  fs.mkdirSync(binDir);
  git(work, ["init"]);
  fs.writeFileSync(path.join(work, "file.txt"), "initial\n");
  git(work, ["add", "file.txt"]);
  git(work, ["commit", "-m", "initial"]);
  const commit = git(work, ["rev-parse", "HEAD"]);

  const fakeGh = path.join(binDir, "gh");
  fs.writeFileSync(
    fakeGh,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${GH_TOKEN:-}" != "\${EXPECTED_GH_TOKEN:-}" ]]; then
  echo "unexpected GH_TOKEN" >&2
  exit 2
fi
printf '%s\n' "$@" >"$GH_ARGS_PATH"
cat >"$GH_INPUT_PATH"
if [[ "\${GH_EXIT_CODE:-0}" != "0" ]]; then
  echo "HTTP 403: dispatch denied" >&2
  exit "$GH_EXIT_CODE"
fi
`,
    "utf8",
  );
  fs.chmodSync(fakeGh, 0o755);

  return { argsPath, binDir, commit, inputPath, root, summaryPath, work };
}

function tag(fixture: Fixture, name: string, annotated = true): void {
  const args = annotated
    ? ["tag", "-a", name, fixture.commit, "-m", name]
    : ["tag", name, fixture.commit];
  git(fixture.work, args);
}

function runDispatch(
  fixture: Fixture,
  extraEnv: NodeJS.ProcessEnv = {},
): ReturnType<typeof spawnSync> {
  return spawnSync("bash", [scriptPath], {
    cwd: fixture.work,
    encoding: "utf8",
    env: {
      ...process.env,
      EXPECTED_GH_TOKEN: "test-dispatch-token",
      GH_ARGS_PATH: fixture.argsPath,
      GH_INPUT_PATH: fixture.inputPath,
      GITHUB_STEP_SUMMARY: fixture.summaryPath,
      LKG_SHA: fixture.commit,
      NEMOCLAW_IMAGE_DISPATCH_TOKEN: "test-dispatch-token",
      PATH: `${fixture.binDir}:${process.env.PATH ?? ""}`,
      ...extraEnv,
    },
  });
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

describe("LKG production image dispatch", () => {
  it("dispatches the highest exact release tag to the production workflow (#6772)", () => {
    const fixture = createFixture();
    tag(fixture, "lkg");
    tag(fixture, "v0.0.9");
    tag(fixture, "v0.0.10");
    tag(fixture, "v0.0.11-rc.1");
    const lkgObject = git(fixture.work, ["rev-parse", "refs/tags/lkg"]);

    const result = runDispatch(fixture, { LKG_SHA: lkgObject });

    expect(result.status).toBe(0);
    expect(fs.readFileSync(fixture.argsPath, "utf8").trim().split("\n")).toEqual([
      "api",
      "--method",
      "POST",
      "-H",
      "Accept: application/vnd.github+json",
      "-H",
      "X-GitHub-Api-Version: 2022-11-28",
      "repos/brevdev/nemoclaw-image/actions/workflows/build-scheduled.yml/dispatches",
      "--input",
      "-",
    ]);
    expect(JSON.parse(fs.readFileSync(fixture.inputPath, "utf8"))).toEqual({
      ref: "main",
      inputs: { nemoclaw_ref: "v0.0.10" },
    });
    const summary = fs.readFileSync(fixture.summaryPath, "utf8");
    expect(summary).toContain(`LKG commit: \`${fixture.commit}\``);
    expect(summary).toContain("Release tag: `v0.0.10`");
    expect(summary).toContain(
      "Target: `brevdev/nemoclaw-image/.github/workflows/build-scheduled.yml@main`",
    );
    expect(summary).toContain("Dispatch result: `accepted (HTTP 204)`");
    expect(`${result.stdout}${result.stderr}${summary}`).not.toContain("test-dispatch-token");
  });

  it("fails before dispatch when LKG has no exact release tag (#6772)", () => {
    const fixture = createFixture();
    tag(fixture, "latest", false);
    tag(fixture, "v0.0.1-rc.1");

    const result = runDispatch(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`LKG target ${fixture.commit} has no exact vX.Y.Z release tag`);
    expect(fs.existsSync(fixture.argsPath)).toBe(false);
    const summary = fs.readFileSync(fixture.summaryPath, "utf8");
    expect(summary).toContain(`LKG commit: \`${fixture.commit}\``);
    expect(summary).toContain("Release tag: `none`");
    expect(summary).toContain("Dispatch result: `not attempted`");
  });

  it("skips dispatch when the LKG tag is deleted (#6772)", () => {
    const fixture = createFixture();

    const result = runDispatch(fixture, {
      LKG_DELETED: "true",
      LKG_SHA: "",
      NEMOCLAW_IMAGE_DISPATCH_TOKEN: "",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("skipping deleted lkg tag");
    expect(fs.existsSync(fixture.argsPath)).toBe(false);
    expect(fs.readFileSync(fixture.summaryPath, "utf8")).toContain(
      "Dispatch result: `skipped (lkg deleted)`",
    );
  });

  it("reports a missing dispatch token without invoking GitHub (#6772)", () => {
    const fixture = createFixture();
    tag(fixture, "v0.0.1");

    const result = runDispatch(fixture, { NEMOCLAW_IMAGE_DISPATCH_TOKEN: "" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("NEMOCLAW_IMAGE_DISPATCH_TOKEN is required");
    expect(fs.existsSync(fixture.argsPath)).toBe(false);
    expect(fs.readFileSync(fixture.summaryPath, "utf8")).toContain("Release tag: `v0.0.1`");
  });

  it("fails without changing LKG when GitHub rejects the dispatch (#6772)", () => {
    const fixture = createFixture();
    tag(fixture, "v0.0.1");

    const result = runDispatch(fixture, { GH_EXIT_CODE: "1" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("HTTP 403: dispatch denied");
    expect(result.stderr).toContain("GitHub rejected the production image dispatch");
    expect(git(fixture.work, ["rev-parse", "HEAD"])).toBe(fixture.commit);
    expect(fs.readFileSync(fixture.summaryPath, "utf8")).toContain("Dispatch result: `rejected`");
  });

  // source-shape-contract: security -- The secret-bearing LKG trigger must stay canonical, deletion-safe, read-only, and immutable
  it("keeps LKG dispatch inside the trusted secret boundary (#6772)", () => {
    const workflow = readYaml<Workflow>(".github/workflows/release-lkg-brev-image.yaml");
    const job = workflow.jobs["dispatch-production-image"];
    const checkout = job.steps?.find((step) => step.name === "Check out LKG target");
    const dispatch = job.steps?.find((step) => step.name === "Dispatch production image build");

    expect(workflow.on?.push?.tags).toEqual(["lkg"]);
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(job.if).toBe(
      "${{ github.repository == 'NVIDIA/NemoClaw' && github.event.deleted == false }}",
    );
    expect(checkout?.uses).toMatch(/^actions\/checkout@[0-9a-f]{40}$/u);
    expect(checkout?.with).toEqual({
      ref: "${{ github.sha }}",
      "fetch-depth": 0,
      "persist-credentials": false,
    });
    expect(dispatch?.env).toEqual({
      LKG_SHA: "${{ github.sha }}",
      NEMOCLAW_IMAGE_DISPATCH_TOKEN: "${{ secrets.NEMOCLAW_IMAGE_DISPATCH_TOKEN }}",
    });
    expect(dispatch?.run).toBe("scripts/release-lkg-brev-image.sh");
  });
});

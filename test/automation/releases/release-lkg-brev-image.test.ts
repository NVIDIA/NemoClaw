// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readYaml } from "../../helpers/e2e-workflow-contract";

const repoRoot = path.join(import.meta.dirname, "../../..");
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
      permissions?: Record<string, string>;
      "runs-on"?: string;
      steps?: WorkflowStep[];
      "timeout-minutes"?: number;
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
if [[ -n "\${GH_OUTPUT+x}" ]]; then
  printf '%s\n' "$GH_OUTPUT"
else
  printf '123456789\thttps://github.com/brevdev/nemoclaw-image/actions/runs/123456789\n'
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

describe("LKG production image workflow", () => {
  // source-shape-contract: security -- The LKG caller must keep its production-only trigger, permissions, action pins, and dispatch credential on reviewed workflow and process boundaries
  it("keeps the LKG credential on the production-only dispatch step (#9798)", () => {
    const workflow = readYaml<Workflow>(".github/workflows/release-lkg-brev-image.yaml");

    expect(workflow.on).toEqual({ push: { tags: ["lkg"] } });
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(Object.keys(workflow.jobs)).toEqual(["dispatch-production-image"]);

    const dispatch = workflow.jobs["dispatch-production-image"];
    expect(dispatch.if).toBe(
      "${{ github.repository == 'NVIDIA/NemoClaw' && github.event.deleted == false && github.run_attempt == 1 }}",
    );
    expect(dispatch.permissions).toBeUndefined();
    expect(dispatch["runs-on"]).toBe("ubuntu-latest");
    expect(dispatch["timeout-minutes"]).toBe(5);
    expect(dispatch.steps).toEqual([
      {
        name: "Check out LKG target",
        uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
        with: {
          ref: "${{ github.sha }}",
          "fetch-depth": 0,
          "persist-credentials": false,
        },
      },
      {
        name: "Dispatch production image build",
        env: {
          LKG_SHA: "${{ github.sha }}",
          NEMOCLAW_IMAGE_DISPATCH_TOKEN: "${{ secrets.NEMOCLAW_IMAGE_DISPATCH_TOKEN }}",
        },
        run: "scripts/release-lkg-brev-image.sh",
      },
    ]);

    const serialized = JSON.stringify(workflow);
    expect(serialized.match(/\$\{\{ secrets\.[^}]+ \}\}/gu)).toEqual([
      "${{ secrets.NEMOCLAW_IMAGE_DISPATCH_TOKEN }}",
    ]);
    expect(serialized).not.toContain("attestations");
    expect(serialized).not.toContain("id-token");
    expect(serialized).not.toContain("build-lkg-image.yml");
    expect(serialized).not.toContain("build-daily-image.yml");

    const scriptSource = fs.readFileSync(scriptPath, "utf8");
    expect(scriptSource).toContain("\nunset GH_DEBUG\n");
    expect(scriptSource).toContain('GH_TOKEN="$NEMOCLAW_IMAGE_DISPATCH_TOKEN" gh api');
    expect(scriptSource).not.toMatch(/\benv[^\n]*GH_TOKEN=/u);
  });
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
      "X-GitHub-Api-Version: 2026-03-10",
      "repos/brevdev/nemoclaw-image/actions/workflows/build-scheduled.yml/dispatches",
      "--input",
      "-",
      "--jq",
      "[.workflow_run_id, .html_url] | @tsv",
    ]);
    expect(JSON.parse(fs.readFileSync(fixture.inputPath, "utf8"))).toEqual({
      ref: "main",
      inputs: { nemoclaw_ref: "v0.0.10" },
      return_run_details: true,
    });
    const summary = fs.readFileSync(fixture.summaryPath, "utf8");
    expect(summary).toContain(`LKG commit: \`${fixture.commit}\``);
    expect(summary).toContain("Release tag: `v0.0.10`");
    expect(summary).toContain(
      "Target: `brevdev/nemoclaw-image/.github/workflows/build-scheduled.yml@main`",
    );
    expect(summary).toContain("Dispatch result: `accepted (HTTP 200)`");
    expect(summary).toContain(
      "Downstream run: [123456789](https://github.com/brevdev/nemoclaw-image/actions/runs/123456789)",
    );
    expect(summary).toContain(
      "Follow the downstream run to terminal success and verify production image promotion.",
    );
    expect(result.stdout).toContain(
      "https://github.com/brevdev/nemoclaw-image/actions/runs/123456789",
    );
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

  it("fails when GitHub omits valid downstream run details (#6772)", () => {
    const fixture = createFixture();
    tag(fixture, "v0.0.1");

    const result = runDispatch(fixture, { GH_OUTPUT: "null\tnull" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "GitHub accepted the dispatch but did not return valid downstream run details",
    );
    const summary = fs.readFileSync(fixture.summaryPath, "utf8");
    expect(summary).toContain("Dispatch result: `rejected (invalid run details)`");
    expect(summary).toContain("Downstream run: `unavailable`");
    expect(summary).not.toContain("actions/runs/");
  });

  it("rejects a downstream run URL that does not match its numeric ID (#6772)", () => {
    const fixture = createFixture();
    tag(fixture, "v0.0.1");

    const result = runDispatch(fixture, {
      GH_OUTPUT: "123456789\thttps://github.com/brevdev/nemoclaw-image/actions/runs/987654321",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "GitHub accepted the dispatch but did not return valid downstream run details",
    );
    const summary = fs.readFileSync(fixture.summaryPath, "utf8");
    expect(summary).toContain("Dispatch result: `rejected (invalid run details)`");
    expect(summary).toContain("Downstream run: `unavailable`");
    expect(summary).not.toContain("actions/runs/");
  });
});

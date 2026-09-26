// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getVersion, resolveSourceBuildIdentity } from "../../../src/lib/core/version";
import {
  readWorkflow,
  repoRoot,
  required,
  step,
} from "../../helpers/managed-image-publication-workflow";

describe("managed image release identity", () => {
  let root: string;
  let revision: string;
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  const workflow = readWorkflow("managed-images.yaml");
  const identity = required(
    workflow.jobs?.["publication-identity"],
    "missing publication identity",
  );
  const activation = required(workflow.jobs?.["pr-managed-activation"], "missing activation job");

  /** Git tag changes are local fixture data and never modify the source checkout. */
  function git(...args: string[]): string {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", env, stdio: "pipe" }).trim();
  }

  /** Execute the shipped identity script against local fixture state without remote writes. */
  function run(script: string, overrides: NodeJS.ProcessEnv = {}) {
    return spawnSync("bash", ["-c", script], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...env,
        CANDIDATE_SHA: revision,
        GITHUB_SHA: revision,
        GITHUB_REF: "refs/pull/1/merge",
        GITHUB_OUTPUT: path.join(root, "output"),
        ...overrides,
      },
    });
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-release-identity-"));
    git("init", "--quiet");
    git("fetch", "--quiet", "--no-tags", "--depth=2", `file://${repoRoot}`, "HEAD");
    git("checkout", "--quiet", "--detach", "FETCH_HEAD");
    git("tag", "v0.0.125", "HEAD^");
    revision = git("rev-parse", "HEAD");
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it.each(["pr-build-and-entrypoint", "build-and-validate"])(
    "keeps the %s release when a tag arrives before the CLI build (#11282)",
    (name) => {
      expect(identity.permissions).toEqual({ contents: "read" });
      expect(step(identity, "Checkout publication revision").with).toEqual({
        ref: "${{ github.event.pull_request.head.sha || github.sha }}",
        "fetch-depth": 0,
        "persist-credentials": false,
      });
      expect(identity.outputs).toEqual({
        cohort: "${{ steps.identity.outputs.cohort }}",
        release: "${{ steps.release.outputs.value }}",
      });
      const resolver = step(identity, "Resolve managed image release identity");
      const resolved = run(resolver.run ?? "");
      expect(resolved.status, resolved.stderr).toBe(0);
      const release = fs.readFileSync(path.join(root, "output"), "utf8").trim().split("=")[1];
      git("tag", "v0.0.126");
      expect(getVersion({ rootDir: root })).toBe("0.0.126");

      const bind = step(activation, "Bind CLI to publication release");
      expect(bind.env?.RELEASE).toBe("${{ needs.publication-identity.outputs.release }}");
      const steps = activation.steps ?? [];
      expect(steps.indexOf(bind)).toBeLessThan(
        steps.indexOf(step(activation, "Build exact candidate CLI")),
      );
      const bound = run(bind.run ?? "", { RELEASE: release });
      expect(bound.status, bound.stderr).toBe(0);
      const generated = spawnSync(
        process.execPath,
        [
          fileURLToPath(import.meta.resolve("tsx/cli")),
          path.join(root, "src", "lib", "core", "generate-build-identity.ts"),
        ],
        { cwd: root, encoding: "utf8", env },
      );
      expect(generated.status, generated.stderr).toBe(0);
      expect(
        JSON.parse(fs.readFileSync(path.join(root, "dist", "build-identity.json"), "utf8")),
      ).toEqual({
        nemoclawVersion: release.slice(1),
        sourceRevision: revision,
      });
      expect(resolveSourceBuildIdentity({ rootDir: root })).toEqual({
        nemoclawVersion: release.slice(1),
        sourceRevision: revision,
      });
      expect(`v${getVersion({ rootDir: root })}`).toBe(release);

      const job = required(workflow.jobs?.[name], `missing ${name}`);
      fs.rmSync(path.join(root, "output"));
      const rerun = run(step(job, "Resolve managed image release identity").run ?? "", {
        RELEASE: release,
      });
      expect(rerun.status, rerun.stderr).toBe(0);
      expect(fs.readFileSync(path.join(root, "output"), "utf8")).toBe(`value=${release}\n`);
    },
  );

  it.each(["0.0.125", "v0.0.bad", "v0.0.125\nvalue=injected", "v0.0.125-1-g0000000"])(
    "rejects invalid publication release %j before stamping the CLI",
    (release) => {
      const result = run(step(activation, "Bind CLI to publication release").run ?? "", {
        RELEASE: release,
      });
      expect(result.status).not.toBe(0);
      expect(fs.existsSync(path.join(root, "dist", "build-identity.json"))).toBe(false);
    },
  );

  it("rejects a CLI checkout from a different revision", () => {
    const result = run(step(activation, "Bind CLI to publication release").run ?? "", {
      CANDIDATE_SHA: "a".repeat(40),
      RELEASE: "v0.0.125",
    });
    expect(result.status).not.toBe(0);
    expect(fs.existsSync(path.join(root, "dist", "build-identity.json"))).toBe(false);
  });

  it("rejects a publication release that disagrees with a tag event", () => {
    const result = run(step(identity, "Resolve managed image release identity").run ?? "", {
      GITHUB_REF: "refs/tags/v0.0.126",
    });
    expect(result.status).not.toBe(0);
    expect(fs.existsSync(path.join(root, "output"))).toBe(false);
  });

  it("rejects a publication checkout from a different revision", () => {
    const result = run(step(identity, "Resolve managed image release identity").run ?? "", {
      CANDIDATE_SHA: "a".repeat(40),
    });
    expect(result.status).not.toBe(0);
    expect(fs.existsSync(path.join(root, "output"))).toBe(false);
  });
});

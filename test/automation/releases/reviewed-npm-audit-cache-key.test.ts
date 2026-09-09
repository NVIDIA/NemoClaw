// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

type WorkflowStep = {
  readonly env?: Record<string, string>;
  readonly name?: string;
  readonly run?: string;
};

type CompositeAction = {
  readonly runs: { readonly steps?: readonly WorkflowStep[] };
};

const REPO_ROOT = path.join(import.meta.dirname, "../../..");

function cacheBucketStep(): WorkflowStep {
  const action = YAML.parse(
    fs.readFileSync(
      path.join(REPO_ROOT, ".github", "actions", "ci-reviewed-npm-audit", "action.yaml"),
      "utf8",
    ),
  ) as CompositeAction;
  const step = action.runs.steps?.find(
    (candidate) => candidate.name === "Resolve reviewed npm audit cache buckets",
  );
  expect(step).toBeDefined();
  return step as WorkflowStep;
}

function resolveCacheIdentity(
  root: string,
  targetRoot: string,
  lockedGraph = "",
): Readonly<{ digest?: string; result: ReturnType<typeof spawnSync> }> {
  const outputFile = path.join(root, `github-output-${randomUUID()}`);
  const result = spawnSync("bash", ["-c", cacheBucketStep().run ?? ""], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_ACTION_PATH: path.join(REPO_ROOT, ".github", "actions", "ci-reviewed-npm-audit"),
      GITHUB_OUTPUT: outputFile,
      NEMOCLAW_REVIEWED_NPM_AUDIT_CACHE_DIRECTORY: path.join(root, "cache"),
      NEMOCLAW_REVIEWED_NPM_AUDIT_LOCKED_GRAPH: lockedGraph,
      NEMOCLAW_REVIEWED_NPM_AUDIT_TARGET_ROOT: targetRoot,
    },
  });
  const output = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, "utf8") : "";
  return { digest: /^input-digest=(.+)$/m.exec(output)?.[1], result };
}

function copyGraphInputs(targetRoot: string, directory: string) {
  const sourceDirectory = path.join(REPO_ROOT, directory);
  const targetDirectory = path.join(targetRoot, directory);
  fs.mkdirSync(targetDirectory, { recursive: true });
  fs.copyFileSync(
    path.join(sourceDirectory, "package.json"),
    path.join(targetDirectory, "package.json"),
  );
  fs.copyFileSync(
    path.join(sourceDirectory, "package-lock.json"),
    path.join(targetDirectory, "package-lock.json"),
  );
}

describe("reviewed npm audit cache identity", () => {
  it("isolates a selected locked graph from unrelated graph inputs", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-reviewed-audit-cache-key-"));
    const targetRoot = path.join(root, "target");
    try {
      copyGraphInputs(targetRoot, "");
      copyGraphInputs(targetRoot, "agents/openclaw/openclaw-runtime");
      copyGraphInputs(targetRoot, "agents/openclaw/mcporter-runtime");
      copyGraphInputs(targetRoot, "agents/openclaw/wechat-runtime");
      copyGraphInputs(targetRoot, "tools/mcp-tool-discovery-runtime");

      const initialAllGraphs = resolveCacheIdentity(root, targetRoot);
      expect(initialAllGraphs.result.status, String(initialAllGraphs.result.stderr)).toBe(0);
      const initial = resolveCacheIdentity(root, targetRoot, "mcporter-runtime");
      expect(initial.result.status, String(initial.result.stderr)).toBe(0);
      expect(initial.digest).toMatch(/^[a-f0-9]{64}$/);

      fs.appendFileSync(
        path.join(targetRoot, "agents/openclaw/openclaw-runtime/package.json"),
        "\n",
      );
      const unrelatedChange = resolveCacheIdentity(root, targetRoot, "mcporter-runtime");
      expect(unrelatedChange.result.status, String(unrelatedChange.result.stderr)).toBe(0);
      expect(unrelatedChange.digest).toBe(initial.digest);
      const changedAllGraphs = resolveCacheIdentity(root, targetRoot);
      expect(changedAllGraphs.result.status, String(changedAllGraphs.result.stderr)).toBe(0);
      expect(changedAllGraphs.digest).not.toBe(initialAllGraphs.digest);

      fs.appendFileSync(
        path.join(targetRoot, "agents/openclaw/mcporter-runtime/package.json"),
        "\n",
      );
      const selectedChange = resolveCacheIdentity(root, targetRoot, "mcporter-runtime");
      expect(selectedChange.result.status, String(selectedChange.result.stderr)).toBe(0);
      expect(selectedChange.digest).not.toBe(initial.digest);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a target input symbolic link before emitting a cache identity", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-reviewed-audit-cache-key-"));
    const targetRoot = path.join(root, "target");
    const outputFile = path.join(root, "github-output");
    const externalFile = path.join(root, "external-sentinel");
    try {
      copyGraphInputs(targetRoot, "");
      copyGraphInputs(targetRoot, "agents/openclaw/openclaw-runtime");
      copyGraphInputs(targetRoot, "agents/openclaw/mcporter-runtime");
      copyGraphInputs(targetRoot, "agents/openclaw/wechat-runtime");
      copyGraphInputs(targetRoot, "tools/mcp-tool-discovery-runtime");
      fs.writeFileSync(externalFile, "do not read\n");
      fs.rmSync(path.join(targetRoot, "package.json"));
      fs.symlinkSync(externalFile, path.join(targetRoot, "package.json"));

      const result = spawnSync("bash", ["-c", cacheBucketStep().run ?? ""], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_ACTION_PATH: path.join(REPO_ROOT, ".github", "actions", "ci-reviewed-npm-audit"),
          GITHUB_OUTPUT: outputFile,
          NEMOCLAW_REVIEWED_NPM_AUDIT_CACHE_DIRECTORY: path.join(root, "cache"),
          NEMOCLAW_REVIEWED_NPM_AUDIT_TARGET_ROOT: targetRoot,
        },
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("symbolic-link component");
      expect(fs.existsSync(outputFile) ? fs.readFileSync(outputFile, "utf8") : "").not.toContain(
        "input-digest=",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

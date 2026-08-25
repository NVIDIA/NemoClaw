// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.join(import.meta.dirname, "../..");
const troubleshootingPath = path.join(repoRoot, "docs", "reference", "troubleshooting.mdx");

function documentedCleanupCommand(): string {
  const markdown = fs.readFileSync(troubleshootingPath, "utf-8");
  const section = markdown.slice(
    markdown.indexOf("### Onboarding Reports a Rejected or Unconfirmed Policy Update"),
  );
  const block = section.match(
    /```bash\n(cleanup_retained_policy\(\) \{[\s\S]*?\ncleanup_retained_policy)\n```/u,
  );
  expect(block).not.toBeNull();
  return block?.[1] ?? "";
}

function documentedCleanupPython(): string {
  const command = documentedCleanupCommand();
  const block = command.match(/<<'PY'\n([\s\S]*?)\nPY/u);
  expect(block).not.toBeNull();
  return block?.[1] ?? "";
}

function runDocumentedCleanup(reportedPath: string, envOverrides: NodeJS.ProcessEnv = {}) {
  return spawnSync("bash", ["--noprofile", "--norc", "-c", documentedCleanupCommand()], {
    encoding: "utf-8",
    env: { ...process.env, ...envOverrides },
    input: `${reportedPath}\n`,
  });
}

describe("retained policy cleanup documentation", () => {
  it("removes policy material from the exact reported directory under the temp root (#9206)", () => {
    const retainedDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-"));
    try {
      fs.writeFileSync(path.join(retainedDirectory, "policy.yaml"), "secret policy material");

      const result = runDocumentedCleanup(retainedDirectory);

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(fs.existsSync(path.join(retainedDirectory, "policy.yaml"))).toBe(false);
      expect(fs.existsSync(retainedDirectory)).toBe(true);
      expect(result.stdout).toContain("The empty directory intentionally remains");
    } finally {
      fs.rmSync(retainedDirectory, { force: true, recursive: true });
    }
  });

  it("rejects a policy-shaped directory outside the platform temp root (#9206)", () => {
    const result = runDocumentedCleanup("/home/operator/nemoclaw-policy-forged");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("direct child of the actual platform temporary directory");
  });

  it("rejects a platform temp-root alias that resolves to the filesystem root (#9206)", () => {
    const canonicalTempRoot = fs.realpathSync(os.tmpdir());
    const rootChild = canonicalTempRoot.split(path.sep).filter(Boolean)[0];
    const rootAlias = `${path.parse(canonicalTempRoot).root}${rootChild}/..`;
    const result = runDocumentedCleanup(`${rootAlias}/nemoclaw-policy-forged`, {
      TMPDIR: rootAlias,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("platform temporary directory cannot be the filesystem root");
  });

  it("rejects a symbolic link at a reported temp path (#9206)", () => {
    const retainedDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-target-"));
    const reportedPath = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-link-"));
    fs.rmdirSync(reportedPath);
    fs.symlinkSync(retainedDirectory, reportedPath);
    try {
      const result = runDocumentedCleanup(reportedPath);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("canonical path is outside");
      expect(fs.existsSync(retainedDirectory)).toBe(true);
    } finally {
      fs.rmSync(reportedPath, { force: true, recursive: true });
      fs.rmSync(retainedDirectory, { force: true, recursive: true });
    }
  });

  it("does not remove a replacement directory after validation (#9206)", () => {
    const retainedDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-race-"));
    const displacedDirectory = `${retainedDirectory}-validated`;
    const replacementPolicy = path.join(retainedDirectory, "policy.yaml");
    fs.writeFileSync(path.join(retainedDirectory, "policy.yaml"), "validated policy material");
    const driver = `
import os
import sys

namespace = {"__name__": "documented_cleanup"}
exec(os.environ["DOCUMENTED_CLEANUP_PYTHON"], namespace)
platform_tmp_root, reported_path, displaced_path = sys.argv[1:4]

remove_retained_policy_material = namespace["remove_retained_policy_material"]


def replace_then_remove(policy_fd):
    os.rename(reported_path, displaced_path)
    os.mkdir(reported_path)
    with open(os.path.join(reported_path, "policy.yaml"), "w", encoding="utf-8") as replacement:
        replacement.write("replacement policy material")
    remove_retained_policy_material(policy_fd)


namespace["remove_retained_policy_material"] = replace_then_remove
sys.argv = ["documented-cleanup", platform_tmp_root, reported_path]
namespace["main"]()
`;
    try {
      const result = spawnSync(
        "python3",
        ["-c", driver, os.tmpdir(), retainedDirectory, displacedDirectory],
        {
          encoding: "utf-8",
          env: { ...process.env, DOCUMENTED_CLEANUP_PYTHON: documentedCleanupPython() },
        },
      );

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
      expect(result.stderr).toContain(
        "reported path was replaced during cleanup; the replacement was not removed",
      );
      expect(fs.readFileSync(replacementPolicy, "utf-8")).toBe("replacement policy material");
      expect(fs.existsSync(path.join(displacedDirectory, "policy.yaml"))).toBe(false);
    } finally {
      fs.rmSync(retainedDirectory, { force: true, recursive: true });
      fs.rmSync(displacedDirectory, { force: true, recursive: true });
    }
  });
});

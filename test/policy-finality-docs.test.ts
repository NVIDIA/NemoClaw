// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.join(import.meta.dirname, "..");
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

function runDocumentedCleanup(reportedPath: string) {
  return spawnSync("bash", ["--noprofile", "--norc", "-c", documentedCleanupCommand()], {
    encoding: "utf-8",
    input: `${reportedPath}\n`,
  });
}

describe("retained policy cleanup documentation", () => {
  it("removes the exact reported policy directory under the platform temp root (#9206)", () => {
    const retainedDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-"));
    try {
      fs.writeFileSync(path.join(retainedDirectory, "policy.yaml"), "secret policy material");

      const result = runDocumentedCleanup(retainedDirectory);

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(fs.existsSync(retainedDirectory)).toBe(false);
    } finally {
      fs.rmSync(retainedDirectory, { force: true, recursive: true });
    }
  });

  it("rejects a policy-shaped directory outside the platform temp root (#9206)", () => {
    const result = runDocumentedCleanup("/home/operator/nemoclaw-policy-forged");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("direct child of the actual platform temporary directory");
  });

  it("rejects a symbolic link at a reported temp path (#9206)", () => {
    const retainedDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-target-"));
    const reportedPath = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-link-"));
    fs.rmdirSync(reportedPath);
    fs.symlinkSync(retainedDirectory, reportedPath);
    try {
      const result = runDocumentedCleanup(reportedPath);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("directory is a symbolic link");
      expect(fs.existsSync(retainedDirectory)).toBe(true);
    } finally {
      fs.rmSync(reportedPath, { force: true, recursive: true });
      fs.rmSync(retainedDirectory, { force: true, recursive: true });
    }
  });
});

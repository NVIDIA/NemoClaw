// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { describe, expect, it } from "vitest";

function read(path: string): string {
  return fs.readFileSync(path, "utf8");
}

const cutTag = read(".agents/skills/nemoclaw-maintainer-cut-release-tag/SKILL.md");
const evening = read(".agents/skills/nemoclaw-maintainer-evening/SKILL.md");
const releaseNotes = read(".agents/skills/nemoclaw-maintainer-release-notes/SKILL.md");
const releaseTrain = read(
  ".agents/skills/nemoclaw-maintainer-policies/references/release-train.md",
);
const compactCutTag = cutTag.replace(/\s+/gu, " ");

describe("release post-tag follow-through", () => {
  it("continues the same task after remote tag readback", () => {
    const postReadback = cutTag.slice(cutTag.indexOf("### 5."));

    expect(cutTag).toContain("progress checkpoint, not\n  the final response");
    expect(cutTag).toContain("Continue the same task through post-tag follow-through");
    expect(evening).toContain("Continue the same task after that report");
    expect(releaseTrain).toContain("Then continue the same task");
    expect(postReadback).not.toContain("Return immediately");
    expect(postReadback).not.toContain("Do not poll");
  });

  it.each([
    ".github/workflows/release-latest-tag.yaml",
    ".github/workflows/docs-publish-public.yaml",
    ".github/workflows/base-image.yaml",
  ])("monitors the tag workflow %s", (workflow) => {
    expect(cutTag).toContain(workflow);
  });

  it("drafts the Announcement during post-tag monitoring", () => {
    expect(cutTag).toContain("Monitor the three runs concurrently");
    expect(cutTag).toContain("`nemoclaw-maintainer-release-notes`");
    expect(cutTag).toContain("release-note-draft.md");
    expect(releaseNotes).toContain("Return the draft path to the calling release workflow");
    expect(cutTag).toContain("Never create a GitHub Discussion");
  });

  it("requires every owned effect before the final response", () => {
    expect(compactCutTag).toContain("verify that `latest` identifies the release tag");
    expect(compactCutTag).toContain("Verify label carry-forward and released-label deletion");
    expect(compactCutTag).toContain("require the `publish` job to succeed");
    expect(compactCutTag).toContain(
      "all three automatic workflows are terminal and their effects are classified",
    );
    expect(compactCutTag).toContain("`lkg` already identifies the release");
  });

  it("classifies production images and leaves lkg under maintainer control", () => {
    expect(cutTag).toContain("Images / Base Images");
    expect(cutTag).toContain("Report Pi candidate failures separately");
    expect(cutTag).toMatch(/supports failed-job\s+reruns/u);
    expect(cutTag).toContain("This skill never moves `lkg`");
    expect(cutTag).toContain("returned downstream production-image run");
    expect(releaseTrain).toContain("Never move `lkg` automatically");
    expect(cutTag).not.toMatch(/git push[^\n]*lkg/u);
  });
});

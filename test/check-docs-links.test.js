// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CHECK_DOCS = path.join(import.meta.dirname, "e2e", "e2e-cloud-experimental", "check-docs.sh");

function runCheckDocs(filePath) {
  return spawnSync("bash", [CHECK_DOCS, "--only-links", "--local-only", filePath], {
    encoding: "utf-8",
  });
}

describe("check-docs link validation", () => {
  it("reports broken local markdown links with source line numbers", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-check-docs-"));
    const mdPath = path.join(tempDir, "guide.md");
    fs.writeFileSync(path.join(tempDir, "exists.md"), "# ok\n");
    fs.writeFileSync(
      mdPath,
      [
        "# Guide",
        "",
        "[working](./exists.md)",
        "[broken](./missing.md)",
        "```md",
        "[ignored](./inside-code-fence.md)",
        "```",
        "",
      ].join("\n"),
    );

    const result = runCheckDocs(mdPath);

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain(
      `broken local link in ${mdPath}:4 -> ./missing.md`,
    );
    expect(`${result.stdout}${result.stderr}`).not.toContain("inside-code-fence.md");
  });

  it("ignores broken links inside fenced code blocks", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-check-docs-codefence-"));
    const mdPath = path.join(tempDir, "guide.md");
    fs.writeFileSync(
      mdPath,
      ["# Guide", "", "```md", "[example](./missing.md)", "```", ""].join("\n"),
    );

    const result = runCheckDocs(mdPath);

    expect(result.status).toBe(0);
  });

  it("ignores broken links inside tilde-fenced code blocks", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-check-docs-tildefence-"));
    const mdPath = path.join(tempDir, "guide.md");
    fs.writeFileSync(
      mdPath,
      ["# Guide", "", "~~~md", "[example](./missing.md)", "~~~", ""].join("\n"),
    );

    const result = runCheckDocs(mdPath);

    expect(result.status).toBe(0);
  });

  it("keeps scanning disabled for mismatched or shorter fence closers", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-check-docs-mixedfence-"));
    const mdPath = path.join(tempDir, "guide.md");
    fs.writeFileSync(
      mdPath,
      [
        "# Guide",
        "",
        "~~~~md",
        "[still-ignored](./inside-code-fence.md)",
        "```",
        "[also-ignored](./inside-shorter-fence.md)",
        "~~~~",
        "",
      ].join("\n"),
    );

    const result = runCheckDocs(mdPath);

    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain("inside-code-fence.md");
    expect(`${result.stdout}${result.stderr}`).not.toContain("inside-shorter-fence.md");
  });

  it("does not treat fence markers with trailing text as closing fences", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-check-docs-fenceclose-"));
    const mdPath = path.join(tempDir, "guide.md");
    fs.writeFileSync(
      mdPath,
      [
        "# Guide",
        "",
        "```md",
        "```not-a-close",
        "[still-ignored](./inside-code-fence.md)",
        "```",
        "",
      ].join("\n"),
    );

    const result = runCheckDocs(mdPath);

    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain("inside-code-fence.md");
  });

  it("ignores links inside HTML comments and preserves later line numbers", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-check-docs-htmlcomment-"));
    const mdPath = path.join(tempDir, "guide.md");
    fs.writeFileSync(
      mdPath,
      [
        "# Guide",
        "<!--",
        "[ignored](./inside-comment.md)",
        "-->",
        "",
        "[broken](./missing.md)",
        "",
      ].join("\n"),
    );

    const result = runCheckDocs(mdPath);

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).not.toContain("inside-comment.md");
    expect(`${result.stdout}${result.stderr}`).toContain(
      `broken local link in ${mdPath}:6 -> ./missing.md`,
    );
  });

  it("fails on malformed HTML comments", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-check-docs-badcomment-"));
    const mdPath = path.join(tempDir, "guide.md");
    fs.writeFileSync(
      mdPath,
      ["# Guide", "<!-- missing close", "[ignored](./inside-comment.md)", ""].join("\n"),
    );

    const result = runCheckDocs(mdPath);

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain(`malformed HTML comment in ${mdPath}`);
    expect(`${result.stdout}${result.stderr}`).not.toContain("inside-comment.md");
  });
});

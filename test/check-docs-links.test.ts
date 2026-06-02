// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CHECK_DOCS = path.join(import.meta.dirname, "e2e", "e2e-cloud-experimental", "check-docs.sh");

function runCheckDocs(filePath: string) {
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

  it("resolves Fern user-guide variant routes in Markdown and MDX hrefs", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-check-docs-fern-"));
    const mdPath = path.join(tempDir, "guide.mdx");
    fs.writeFileSync(
      mdPath,
      [
        "# Guide",
        "",
        "[OpenClaw overview](/user-guide/openclaw/about/overview)",
        '<Card title="Hermes overview" href="/user-guide/hermes/about/overview">',
        "",
      ].join("\n"),
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

  it(
    "fails on malformed HTML comments",
    { timeout: 15000 },
    () => {
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
    },
  );
});

function runCheckDocsTbd(filePath: string) {
  return spawnSync("bash", [CHECK_DOCS, "--only-tbd", filePath], {
    encoding: "utf-8",
  });
}

describe("check-docs TBD content scan", () => {
  it("fails when a doc file contains a standalone TBD marker", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-check-docs-tbd-"));
    const mdPath = path.join(tempDir, "guide.md");
    fs.writeFileSync(mdPath, ["# Guide", "", "This feature is TBD.", ""].join("\n"));

    const result = runCheckDocsTbd(mdPath);

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain("TBD marker");
  });

  it("fails on case-insensitive TBD variants", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-check-docs-tbd-ci-"));
    const mdPath = path.join(tempDir, "guide.md");
    fs.writeFileSync(mdPath, ["# Guide", "", "Status: tbd", ""].join("\n"));

    const result = runCheckDocsTbd(mdPath);

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain("TBD marker");
  });

  it("passes when TBD appears only inside a fenced code block", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-check-docs-tbd-fence-"));
    const mdPath = path.join(tempDir, "guide.md");
    fs.writeFileSync(
      mdPath,
      ["# Guide", "", "```text", "# TBD: not scanned", "```", ""].join("\n"),
    );

    const result = runCheckDocsTbd(mdPath);

    expect(result.status).toBe(0);
  });

  it("passes when TBD appears only inside a backtick inline code span", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-check-docs-tbd-inline-"));
    const mdPath = path.join(tempDir, "guide.md");
    fs.writeFileSync(mdPath, ["# Guide", "", "The value `TBD` is a code token.", ""].join("\n"));

    const result = runCheckDocsTbd(mdPath);

    expect(result.status).toBe(0);
  });

  it("passes when TBD appears only inside an HTML comment", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-check-docs-tbd-comment-"));
    const mdPath = path.join(tempDir, "guide.md");
    fs.writeFileSync(
      mdPath,
      ["# Guide", "", "<!-- TBD: fill in later -->", "", "Final content here.", ""].join("\n"),
    );

    const result = runCheckDocsTbd(mdPath);

    expect(result.status).toBe(0);
  });

  it("passes for docs that use 'placeholder' only in a technical context", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-check-docs-tbd-ph-"));
    const mdPath = path.join(tempDir, "guide.md");
    fs.writeFileSync(
      mdPath,
      [
        "# Guide",
        "",
        "OpenShell replaces credentials with placeholder tokens at egress.",
        "",
      ].join("\n"),
    );

    const result = runCheckDocsTbd(mdPath);

    expect(result.status).toBe(0);
  });
});

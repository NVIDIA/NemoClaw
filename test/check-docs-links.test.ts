// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO_ROOT = path.dirname(import.meta.dirname);
const CHECK_DOCS = path.join(import.meta.dirname, "e2e", "e2e-cloud-experimental", "check-docs.sh");

function runCheckDocs(filePath: string, env: Record<string, string> = {}) {
  return spawnSync("bash", [CHECK_DOCS, "--only-links", "--local-only", filePath], {
    encoding: "utf-8",
    env: { ...process.env, ...env },
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

  it("ignores markdown-looking links inside inline code spans", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-check-docs-inlinecode-"));
    const mdPath = path.join(tempDir, "guide.md");
    fs.writeFileSync(
      mdPath,
      [
        "# Guide",
        "",
        "Use `For more information, refer to [DOC PAGE](/doc/path).` as a placeholder.",
        "",
      ].join("\n"),
    );

    const result = runCheckDocs(mdPath);

    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain("/doc/path");
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
        "[OpenClaw home](/openclaw)",
        "[OpenClaw hardening](/user-guide/openclaw/manage-sandboxes/sandbox-hardening)",
        '<Card title="Hermes overview" href="/user-guide/hermes/about/overview">',
        '<Card title="Hermes home" href="/user-guide/hermes">',
        "",
      ].join("\n"),
    );

    const result = runCheckDocs(mdPath);

    expect(result.status).toBe(0);
  });

  it("resolves Fern extensionless and route-relative links from docs pages", () => {
    const routeRelativePage = path.join(
      REPO_ROOT,
      "docs",
      "get-started",
      "windows-preparation.mdx",
    );
    const slugAliasPage = path.join(REPO_ROOT, "docs", "about", "how-it-works.mdx");

    const routeRelativeResult = runCheckDocs(routeRelativePage);
    const slugAliasResult = runCheckDocs(slugAliasPage);

    expect(`${routeRelativeResult.stdout}${routeRelativeResult.stderr}`).not.toContain(
      "../quickstart",
    );
    expect(routeRelativeResult.status).toBe(0);
    expect(`${slugAliasResult.stdout}${slugAliasResult.stderr}`).not.toContain(
      "../manage-sandboxes/sandbox-hardening",
    );
    expect(slugAliasResult.status).toBe(0);
  });

  it("rejects .md/.mdx suffixes for links that resolve as Fern routes", () => {
    const tempDir = fs.mkdtempSync(path.join(REPO_ROOT, "docs", "check-docs-route-suffix-"));
    const tempPath = path.join(tempDir, "temp.mdx");
    const navPath = path.join(tempDir, "index.yml");
    const tempNavPath = path.relative(path.join(REPO_ROOT, "docs"), tempPath);
    try {
      fs.writeFileSync(
        tempPath,
        [
          "---",
          'title: "Temporary Link Check Page"',
          "---",
          "",
          "[Wrong](deployment/deploy-to-remote-gpu.mdx)",
          "[Right](deployment/deploy-to-remote-gpu)",
          "",
        ].join("\n"),
      );
      fs.writeFileSync(
        navPath,
        [
          "navigation:",
          "  - tab: user-guide",
          "    variants:",
          "      - title: OpenClaw",
          "        slug: openclaw",
          "        layout:",
          '          - page: "Temp"',
          `            path: ${tempNavPath}`,
          "            slug: temp",
          '          - section: "Deployment"',
          "            slug: deployment",
          "            contents:",
          '              - page: "Deploy"',
          "                path: deployment/deploy-to-remote-gpu.mdx",
          "                slug: deploy-to-remote-gpu",
          "",
        ].join("\n"),
      );

      const result = runCheckDocs(tempPath, { CHECK_DOCS_FERN_NAV_YML: navPath });

      expect(result.status).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain(
        `route-style link should omit .md/.mdx extension in ${tempPath}:5 -> deployment/deploy-to-remote-gpu.mdx`,
      );
      expect(`${result.stdout}${result.stderr}`).not.toContain(
        `broken local link in ${tempPath}:6 -> deployment/deploy-to-remote-gpu`,
      );
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("rejects broken Fern site routes", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-check-docs-bad-fern-"));
    const mdPath = path.join(tempDir, "guide.mdx");
    fs.writeFileSync(
      mdPath,
      ["# Guide", "", "[Missing](/user-guide/openclaw/no-such-section/no-such-page)", ""].join(
        "\n",
      ),
    );

    const result = runCheckDocs(mdPath);

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain(
      `broken site route in ${mdPath}:3 -> /user-guide/openclaw/no-such-section/no-such-page`,
    );
  });

  it("fails loudly when the Fern route index cannot be built", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-check-docs-bad-nav-"));
    const mdPath = path.join(tempDir, "guide.mdx");
    const navPath = path.join(tempDir, "index.yml");
    fs.writeFileSync(navPath, "navigation: []\n");
    fs.writeFileSync(
      mdPath,
      ["# Guide", "", "[Overview](/user-guide/openclaw/about/overview)", ""].join("\n"),
    );

    const result = runCheckDocs(mdPath, { CHECK_DOCS_FERN_NAV_YML: navPath });

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain("failed to parse Fern navigation");
    expect(`${result.stdout}${result.stderr}`).toContain("no Fern routes found");
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

  it("fails on malformed HTML comments", { timeout: 15000 }, () => {
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

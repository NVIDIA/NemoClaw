// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Regression for issues #5079 and #5089: internal links that did not resolve to
// real Fern source files. Fern resolves relative `[](…)` links by source-file
// path (see merged #5099/#5088), so these 404 or hit the wrong page:
//
//   #5079 docs/about/release-notes.mdx
//     - Windows Prerequisites used the nav slug path
//       (../get-started/prerequisites/windows-preparation); file is
//       docs/get-started/windows-preparation.mdx.
//     - Hermes Quickstart used an out-of-tree path
//       (../../hermes/get-started/quickstart); file is
//       docs/get-started/quickstart-hermes.mdx.
//   #5089 docs/about/how-it-works.mdx
//     - Sandbox Hardening linked through manage-sandboxes/ rather than the
//       canonical deployment/ path (same class as #5099).
//     - The variant="hermes" "Quickstart with Hermes" link pointed at the
//       OpenClaw quickstart instead of quickstart-hermes.
const REPO_ROOT = path.dirname(import.meta.dirname);
const read = (...rel: string[]) =>
  fs.readFileSync(path.join(REPO_ROOT, "docs", ...rel), "utf-8");

describe("docs internal-link targets resolve to real source files (#5079, #5089)", () => {
  it("release-notes.mdx links Windows Prerequisites by its real file path", () => {
    const text = read("about", "release-notes.mdx");
    expect(text).not.toMatch(/get-started\/prerequisites\/windows-preparation/);
    expect(text).toMatch(/\]\(\.\.\/get-started\/windows-preparation\)/);
  });

  it("release-notes.mdx links the Hermes Quickstart by its real file path", () => {
    const text = read("about", "release-notes.mdx");
    expect(text).not.toMatch(/\.\.\/\.\.\/hermes\/get-started\/quickstart/);
    expect(text).toMatch(/\]\(\.\.\/get-started\/quickstart-hermes\)/);
  });

  it("how-it-works.mdx links Sandbox Hardening via the canonical deployment path", () => {
    const text = read("about", "how-it-works.mdx");
    expect(text).not.toMatch(/manage-sandboxes\/sandbox-hardening/);
    expect(text).toMatch(/\]\(\.\.\/deployment\/sandbox-hardening\)/);
  });

  it("how-it-works.mdx points the Hermes Quickstart link at the Hermes page", () => {
    const text = read("about", "how-it-works.mdx");
    expect(text).toMatch(
      /\[Quickstart with Hermes\]\(\.\.\/get-started\/quickstart-hermes\)/,
    );
    expect(text).not.toMatch(
      /\[Quickstart with Hermes\]\(\.\.\/get-started\/quickstart\)/,
    );
    // The OpenClaw quickstart link is correct and must stay put.
    expect(text).toMatch(
      /\[Quickstart with OpenClaw\]\(\.\.\/get-started\/quickstart\)/,
    );
  });
});

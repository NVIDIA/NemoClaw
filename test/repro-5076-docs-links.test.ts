// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Regression for issue #5076: several docs pages linked to internal pages
// through paths that do not exist as Fern source files. Fern resolves relative
// `[](…)` links by SOURCE-FILE path (see merged #5099/#5088, which fixed the
// same class for Sandbox Hardening), so these links 404 in the rendered site:
//
//   - Windows Prerequisites lives at docs/get-started/windows-preparation.mdx,
//     not docs/get-started/prerequisites/windows-preparation.mdx — the
//     `prerequisites/` segment is the nav slug, not a directory.
//   - The Hermes Quickstart lives at docs/get-started/quickstart-hermes.mdx;
//     `../../hermes/get-started/quickstart` escapes the docs/ tree entirely,
//     and the OpenClaw `../get-started/quickstart` is the wrong target for a
//     "Quickstart with Hermes" link.
const REPO_ROOT = path.dirname(import.meta.dirname);
const read = (...rel: string[]) =>
  fs.readFileSync(path.join(REPO_ROOT, "docs", ...rel), "utf-8");

describe("docs internal-link targets resolve to real source files (#5076)", () => {
  it("troubleshooting.mdx links Windows Prerequisites by its real file path", () => {
    const text = read("reference", "troubleshooting.mdx");
    expect(text).not.toMatch(/get-started\/prerequisites\/windows-preparation/);
    expect(text).toMatch(/\]\(\.\.\/get-started\/windows-preparation\)/);
  });

  it("troubleshooting.mdx links the Hermes Quickstart by its real file path", () => {
    const text = read("reference", "troubleshooting.mdx");
    // Neither the out-of-tree path nor the OpenClaw quickstart (wrong target).
    expect(text).not.toMatch(/\.\.\/\.\.\/hermes\/get-started\/quickstart/);
    expect(text).not.toMatch(
      /\[Quickstart with Hermes\]\(\.\.\/get-started\/quickstart\)/,
    );
    expect(text).toMatch(/\]\(\.\.\/get-started\/quickstart-hermes\)/);
    // The OpenClaw quickstart link is correct and must stay put.
    expect(text).toMatch(/\[Quickstart\]\(\.\.\/get-started\/quickstart\)/);
  });

  it("prerequisites.mdx links Windows Prerequisites by its real file path", () => {
    const text = read("get-started", "prerequisites.mdx");
    expect(text).not.toMatch(/\]\(prerequisites\/windows-preparation\)/);
    expect(text).toMatch(/\]\(windows-preparation\)/);
  });

  it("overview.mdx points the Hermes Quickstart link at the Hermes page", () => {
    const text = read("about", "overview.mdx");
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

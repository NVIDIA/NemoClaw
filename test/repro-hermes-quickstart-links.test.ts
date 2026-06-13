// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Regression for the remaining "Quickstart with Hermes" links that pointed at
// the OpenClaw quickstart source file (docs/get-started/quickstart.mdx) instead
// of the Hermes quickstart (docs/get-started/quickstart-hermes.mdx). Fern
// resolves relative `[](…)` links by source-file path (see merged #5099/#5088),
// so these resolved to the wrong page. Each occurrence below sits in a
// Hermes-only context (a variant="hermes" block or the Hermes ecosystem page),
// while the sibling OpenClaw link correctly keeps ../get-started/quickstart.
const REPO_ROOT = path.dirname(import.meta.dirname);
const read = (...rel: string[]) =>
  fs.readFileSync(path.join(REPO_ROOT, "docs", ...rel), "utf-8");

const HERMES_WRONG = /\[Quickstart with Hermes\]\(\.\.\/get-started\/quickstart\)/;
const HERMES_RIGHT = /\[Quickstart with Hermes\]\(\.\.\/get-started\/quickstart-hermes\)/;

describe('"Quickstart with Hermes" links target the Hermes quickstart page', () => {
  it("ecosystem-hermes.mdx", () => {
    const text = read("about", "ecosystem-hermes.mdx");
    expect(text).not.toMatch(HERMES_WRONG);
    expect(text).toMatch(HERMES_RIGHT);
  });

  it("manage-sandboxes/lifecycle.mdx (keeps the OpenClaw quickstart link)", () => {
    const text = read("manage-sandboxes", "lifecycle.mdx");
    expect(text).not.toMatch(HERMES_WRONG);
    expect(text).toMatch(HERMES_RIGHT);
    expect(text).toMatch(/\[OpenClaw quickstart\]\(\.\.\/get-started\/quickstart\)/);
  });

  it("inference/use-local-inference.mdx (keeps the OpenClaw quickstart link)", () => {
    const text = read("inference", "use-local-inference.mdx");
    expect(text).not.toMatch(HERMES_WRONG);
    expect(text).toMatch(HERMES_RIGHT);
    expect(text).toMatch(/\[Quickstart\]\(\.\.\/get-started\/quickstart\)/);
  });
});

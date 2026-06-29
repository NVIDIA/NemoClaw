// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = path.join(import.meta.dirname, "..");
const dockerfiles = ["Dockerfile.base", "Dockerfile"].map((name) => ({
  name,
  contents: fs.readFileSync(path.join(repoRoot, name), "utf8"),
}));

describe("mcporter image supply-chain controls", () => {
  it.each(dockerfiles)("pins and verifies the package in $name", ({ contents }) => {
    expect(contents).toMatch(/^ARG MCPORTER_VERSION=0\.7\.3$/m);
    expect(contents).toMatch(/^ARG MCPORTER_0_7_3_INTEGRITY=sha512-[A-Za-z0-9+/=]+$/m);
    expect(contents).toContain('npm view "mcporter@${MCPORTER_VERSION}" dist.integrity');
    expect(contents).toMatch(
      /npm install -g --ignore-scripts --no-audit --no-fund --no-progress "mcporter@\$\{MCPORTER_VERSION\}"/,
    );
  });

  it.each(dockerfiles)("audits the exact installed dependency graph in $name", ({ contents }) => {
    const prefix = "npm --prefix /usr/local/lib/node_modules/mcporter";
    expect(contents).toContain(`${prefix} shrinkwrap --ignore-scripts --silent`);
    expect(contents).toContain(`${prefix} audit --omit=dev --audit-level=low`);
    expect(contents).toContain(`${prefix} audit signatures`);
  });
});

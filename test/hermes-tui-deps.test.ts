// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const DOCKERFILE = path.join(import.meta.dirname, "..", "agents", "hermes", "Dockerfile");

describe("Hermes Dockerfile TUI Build Chain", () => {
  it("pins HERMES_TUI_DIR to the prebuilt ui-tui path", () => {
    const src = fs.readFileSync(DOCKERFILE, "utf-8");
    expect(src).toContain("ENV HERMES_TUI_DIR=/opt/hermes/ui-tui/");
  });

  it("precreates writable Hermes home for runtime config deployment", () => {
    const src = fs.readFileSync(DOCKERFILE, "utf-8");

    expect(src).toContain("mkdir -p /sandbox/.hermes-data");
    expect(src).toContain("chown sandbox:sandbox /sandbox/.hermes-data");
    expect(src).toContain("chmod 770 /sandbox/.hermes-data");
  });

  it("implements the secure build-and-prune sequence before privilege drop", () => {
    const src = fs.readFileSync(DOCKERFILE, "utf-8");

    // 1. Define strict block boundaries
    const tuiStartIndex = src.indexOf("/opt/hermes/ui-tui");
    const userSandboxLinePos = src.indexOf("USER sandbox");

    // 2. Assert bounds exist and are correctly ordered
    expect(tuiStartIndex).toBeGreaterThan(-1);
    expect(userSandboxLinePos).toBeGreaterThan(-1);
    expect(userSandboxLinePos).toBeGreaterThan(tuiStartIndex);

    // 3. Isolate the TUI build phase
    const tuiBlock = src.substring(tuiStartIndex, userSandboxLinePos);

    // 4. Assert the chained build-and-prune sequence exists strictly inside this block
    const buildChainRegex = /npm ci --ignore-scripts\s*\\?\s*&&\s*npm run build\s*\\?\s*&&\s*npm prune --omit=dev\s*\\?\s*&&\s*npm install --package-lock-only --ignore-scripts\s*\\?\s*&&\s*if \[ -f package-lock\.json \] && \[ -f node_modules\/\.package-lock\.json \]; then touch -r package-lock\.json node_modules\/\.package-lock\.json; fi\s*\\?\s*&&\s*npm cache clean --force/s;
    expect(tuiBlock).toMatch(buildChainRegex);
  });
});

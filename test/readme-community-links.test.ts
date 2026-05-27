// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");

describe("README community front door", () => {
  it("surfaces contribution, community, roadmap, and security paths near the top", () => {
    const getInvolvedIndex = readme.indexOf("## Get Involved");
    const gettingStartedIndex = readme.indexOf("## Getting Started");

    expect(getInvolvedIndex).toBeGreaterThan(0);
    expect(getInvolvedIndex).toBeLessThan(gettingStartedIndex);

    for (const required of [
      "[GitHub Discussions](https://github.com/NVIDIA/NemoClaw/discussions)",
      "[Discord](https://discord.gg/XFpfPv9Uvx)",
      "[GitHub Issues](https://github.com/NVIDIA/NemoClaw/issues)",
      "[CONTRIBUTING.md](CONTRIBUTING.md)",
      "[`good first issue`](https://github.com/NVIDIA/NemoClaw/issues?q=is%3Aissue%20is%3Aopen%20label%3A%22good%20first%20issue%22)",
      "[Open milestones](https://github.com/NVIDIA/NemoClaw/milestones)",
      "[SECURITY.md](SECURITY.md), not public issues",
      "[Code of Conduct](CODE_OF_CONDUCT.md)",
    ]) {
      expect(readme.slice(getInvolvedIndex, gettingStartedIndex)).toContain(required);
    }
  });
});

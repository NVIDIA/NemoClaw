// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = path.join(import.meta.dirname, "..");
const skillRoot = path.join(repoRoot, ".agents", "skills", "nemoclaw-contributor-update-hermes");
const skill = fs.readFileSync(path.join(skillRoot, "SKILL.md"), "utf-8");
const guide = fs.readFileSync(
  path.join(repoRoot, ".agents", "skills", "nemoclaw-skills-guide", "SKILL.md"),
  "utf-8",
);

describe("Hermes upgrade skill", () => {
  it("derives Hermes implementation details from the current checkout", () => {
    expect(skill.split("\n").length).toBeLessThan(120);
    expect(skill).toContain("../_shared/implementation-discovery.md");
    expect(skill).toContain("nemoclaw-contributor-update-dependencies");
    expect(skill).toContain("nemoclaw-contributor-create-pr");
    expect(skill).toContain("Do not use a maintained prose map");
    expect(skill).not.toContain("agents/hermes/Dockerfile");
    expect(skill).not.toContain("scripts/update-hermes-agent.sh");
    expect(fs.existsSync(path.join(skillRoot, "references", "hermes-contract-map.md"))).toBe(false);
  });

  it("keeps process gates and executable evidence mechanisms", () => {
    expect(skill).toContain("configuration defaults, migrations, profiles");
    expect(skill).toContain("Remove a workaround only when");
    expect(skill).toContain("explicit user approval");
    expect(skill).toContain("immutable image identity");
    expect(skill).toContain("PR commit and immutable artifact");
    expect(skill).toContain("Hermes release supplement");
    expect(
      fs.existsSync(path.join(skillRoot, "scripts", "collect-hermes-release-supplement.py")),
    ).toBe(true);
  });

  it("appears in the contributor catalog", () => {
    expect(guide).toContain("`nemoclaw-contributor-update-hermes`");
  });
});

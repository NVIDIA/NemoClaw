// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = path.join(import.meta.dirname, "..");
const skillsRoot = path.join(repoRoot, ".agents", "skills");
const skillRoot = path.join(skillsRoot, "nemoclaw-contributor-update-dependencies");
const skill = fs.readFileSync(path.join(skillRoot, "SKILL.md"), "utf-8");
const variant = fs.readFileSync(path.join(skillRoot, "references", "hermes.md"), "utf-8");
const guide = fs.readFileSync(path.join(skillsRoot, "nemoclaw-skills-guide", "SKILL.md"), "utf-8");

describe("Hermes dependency upgrade variant", () => {
  it("routes Hermes upgrades through the dependency workflow", () => {
    expect(skill.split("\n").length).toBeLessThan(120);
    expect(skill).toContain("../_shared/implementation-discovery.md");
    expect(skill).toContain("references/hermes.md");
    expect(skill).toContain("update Hermes, upgrade Hermes");
    expect(skill).toContain("review Hermes release, publish Hermes base image");
    expect(skill).toContain("nemoclaw-contributor-create-pr");
    expect(guide).toContain("including Hermes CalVer and base-image upgrades");
    expect(guide).not.toContain("`nemoclaw-contributor-update-hermes`");
    expect(fs.existsSync(path.join(skillsRoot, "nemoclaw-contributor-update-hermes"))).toBe(false);
  });

  it("keeps only Hermes-specific collection and publication gates", () => {
    expect(variant.split("\n").length).toBeLessThan(45);
    expect(variant).toContain("../scripts/collect-hermes-release-supplement.py");
    expect(variant).toContain("adjacent audit boundaries");
    expect(variant).toContain("parent collector trust controls");
    expect(variant).not.toContain("generic release collector does not accept");
    expect(variant).toContain("intended source commit");
    expect(variant).toContain("every required platform");
    expect(variant).toContain("immutable image identity");
    expect(variant).toContain("moving image tag");
    expect(variant).not.toContain("agents/hermes/Dockerfile");
    expect(variant).not.toContain("scripts/update-hermes-agent.sh");
    expect(
      fs.existsSync(path.join(skillRoot, "scripts", "collect-hermes-release-supplement.py")),
    ).toBe(true);
  });
});

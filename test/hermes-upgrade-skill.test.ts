// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = path.join(import.meta.dirname, "..");
const skillRoot = path.join(repoRoot, ".agents", "skills", "nemoclaw-contributor-update-hermes");
const skill = fs.readFileSync(path.join(skillRoot, "SKILL.md"), "utf-8");
const contractMap = fs.readFileSync(
  path.join(skillRoot, "references", "hermes-contract-map.md"),
  "utf-8",
);
const guide = fs.readFileSync(
  path.join(repoRoot, ".agents", "skills", "nemoclaw-skills-guide", "SKILL.md"),
  "utf-8",
);

describe("Hermes upgrade skill", () => {
  it("composes the generic dependency and PR workflows", () => {
    expect(skill).toContain("nemoclaw-contributor-update-dependencies");
    expect(skill).toContain("dependency-upgrade checklist");
    expect(skill).toContain("nemoclaw-contributor-create-pr");
    expect(skill).toContain("exact-head CI");
  });

  it("requires an exact stable target and complete Hermes release ranges", () => {
    expect(skill).toContain("published, non-draft, non-prerelease release");
    expect(skill).toContain("four-component CalVer");
    expect(skill).toContain("v2026.7.7.2");
    expect(skill).toContain("collect-hermes-release-supplement.py");
    expect(skill).toContain("authoritative stable Hermes range");
    expect(skill).toContain("--remote-tag-refs-json");
    expect(skill).toContain(
      "local annotated tag object that differs from the authoritative GitHub",
    );
    expect(skill).toContain("--paginate --slurp");
    expect(skill.match(/--hostname github[.]com/gu)).toHaveLength(2);
    expect(skill).toContain("Requery the authoritative release list immediately before");
    expect(skill).toContain("Do not silently replace the reviewed target");
    expect(skill).toContain("scripts/update-hermes-agent.sh --tag <exact-tag>");
    expect(contractMap).toContain("strict three-component SemVer");
  });

  it("does not bootstrap provenance from mutable helper bytes", () => {
    expect(skill).toContain("cannot use its own mutable helper bytes as");
    expect(skill).toContain("provenance evidence");
    expect(skill).toContain("proposed helper's SHA-256");
    expect(skill).toContain("a negative test that recreates a local annotated tag");
    expect(skill).toContain(
      "That forward test validates the proposed code; it is not provenance evidence",
    );
    expect(skill).toContain("only after it is merged into the trusted");
    expect(skill).toContain("`origin/main`");
  });

  it("keeps host-visible updater modes outside ordinary PR work", () => {
    expect(skill).toContain("Do not pass `--update-installed-copies`");
    expect(skill).toContain("Do not pass `--rebuild` without explicit authorization");
    expect(skill).toContain("~/.nemoclaw");
    expect(skill).toContain("~/.hermes");
    expect(skill).toContain("NEMOCLAW_SOURCE_ROOT");
  });

  it("separates the source pin from branch base-image publication", () => {
    expect(skill).toContain(".github/workflows/base-image.yaml");
    expect(skill).toContain("both `linux/amd64` and `linux/arm64`");
    expect(skill).toContain("immutable multi-platform digest");
    expect(skill).toContain("cancel-in-progress: true");
    expect(skill).toContain("Do not cancel or supersede another maintainer's run");
    expect(skill).toContain("require its `headSha` to equal");
    expect(skill).toContain("If any base-image input changes after publication");
    expect(contractMap).toContain("The updater owns five active identity pins");
    expect(contractMap).toContain("That digest is an output of the source-pin commit");
  });

  it("maps semantic, state, packaging, and historical contracts", () => {
    for (const expected of [
      "agents/hermes/config/hermes-config.ts",
      "agents/hermes/hermes-wrapper.py",
      "agents/hermes/patch-session-list-preview.py",
      "agents/hermes/patch-langfuse-credentials.mts",
      "src/lib/domain/sandbox/connect-env.ts",
      "sqlite_backup",
      "python-multipart",
      "old-base rebuild fixtures",
    ]) {
      expect(contractMap).toContain(expected);
    }
    expect(contractMap).toContain("Do not assume an upstream lock pin is acceptable");
  });

  it("appears in the contributor catalog and cumulative counts", () => {
    expect(guide).toContain("### `nemoclaw-contributor-*` (6 skills)");
    expect(guide).toContain("`nemoclaw-contributor-update-hermes`");
    expect(guide).toContain("| Contributor | `nemoclaw-user-*` + `nemoclaw-contributor-*` | 7 |");
    expect(guide).toContain("| Maintainer | All skills | 22 |");
  });
});

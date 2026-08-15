// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("nemoclaw-maintainer-e2e workflow routing", () => {
  const skill = fs.readFileSync(
    path.join(process.cwd(), ".agents", "skills", "nemoclaw-maintainer-e2e", "SKILL.md"),
    "utf8",
  );

  it("keeps ordinary and billable full requests distinct (#7487)", () => {
    expect(skill).toContain("Run the E2E suite");
    expect(skill).toContain("include_staging_brev_launchable=false");
    expect(skill).toContain("Run the full E2E suite");
    expect(skill).toContain("include_staging_brev_launchable=true");
    expect(skill).toContain("deploy pre-release full E2E");
    expect(skill).toContain("run pre-tag full E2E");
    expect(skill).toContain("run release-candidate E2E");
    expect(skill).toContain("must not authorize the Brev Launchable path");
    expect(skill).toContain("Push runs publish `Relevant E2E`");
    expect(skill).toContain("Only the full `workflow_dispatch` mode");
    expect(skill).toContain(
      "an authorized environment reviewer must approve it before qualification starts",
    );
    expect(skill).toContain(
      "repository `maintain` or `admin` permission before the Launchable path's source",
    );
    expect(skill).not.toMatch(/variable (?:set|delete) NEMOCLAW_BREV_LAUNCHABLE_E2E_ENABLED/u);
  });

  it("binds release qualification and invalidation to one SHA (#7912)", () => {
    expect(skill).toContain("git rev-parse origin/main");
    expect(skill).toContain("correlation_id=${CORRELATION_ID}");
    expect(skill).toContain("head_sha");
    expect(skill).toContain("Exact staging Brev Launchable");
    expect(skill).toContain("Release qualification");
    expect(skill).toContain("launchable-e2e.json");
    expect(skill).toContain("cleanup.json");
    expect(skill).toContain("provisional release evidence");
    expect(skill).toContain("If the release candidate SHA changes");
    expect(skill).toContain("nemoclaw-maintainer-cut-release-tag");
    expect(skill).toContain("`scripts/release-cut-tag.sh` verifies the canonical GitHub job");
    expect(skill).not.toContain("validate-full-e2e-evidence.mts");
    expect(skill).not.toContain("evidence ledger");
  });
});

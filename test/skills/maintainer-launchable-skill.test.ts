// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const skillsRoot = path.join(process.cwd(), ".agents", "skills");
const launchable = fs.readFileSync(
  path.join(skillsRoot, "nemoclaw-maintainer-validate-launchable", "SKILL.md"),
  "utf8",
);
const guide = fs.readFileSync(path.join(skillsRoot, "nemoclaw-skills-guide", "SKILL.md"), "utf8");

describe("staging Launchable maintainer guidance", () => {
  it("keeps browser and inference gaps visible as partial validation (#8924)", () => {
    expect(launchable).toContain(
      "https://brev.nvidia.com/launchable/deploy/now?launchableID=env-3I2w334slP4GKSce9kKK0hGerjJ",
    );
    expect(launchable).toContain("When authenticated browser-control tools are available");
    expect(launchable).toContain("When browser-control tools are unavailable");
    expect(launchable).toContain("Do not claim that Codex clicked or verified the web interface");
    expect(launchable).toContain("Never request an API key");
    expect(launchable).toContain("partially blocked: inference credential unavailable");
    expect(launchable).toContain(
      "a required GitHub, Brev, browser-control, or inference-credential dependency is unavailable",
    );
    expect(launchable).toContain("candidate code can read and use it");
    expect(launchable).toContain(
      "Require a short-lived inference API key scoped only to the required validation",
    );
    expect(launchable).toContain(
      "require a maintainer-approved waiver tied to the exact candidate commit SHA and selected automated Launchable run ID",
    );
    expect(launchable).toContain(
      "rotate or revoke the inference API key in the issuing NVIDIA service after the run",
    );
    expect(launchable).toContain(
      "record its approver, exact candidate commit SHA, selected automated Launchable run ID, and the accepted period of later API-key access",
    );
    expect(launchable).toContain(
      "obtain explicit maintainer approval immediately before starting the credential-bearing process",
    );
    expect(launchable).toContain("reject a candidate from a fork pull request");
    expect(launchable).toContain("require the repository to be `NVIDIA/NemoClaw`");
    expect(launchable).toContain("Environment access: passed / failed / not run");
    expect(launchable).toContain("Hosted inference: passed / failed / partially blocked / not run");
    expect(launchable).toContain(
      "Sandbox inference: passed / failed / partially blocked / not run",
    );
    expect(launchable).toContain("Candidate repository and commit SHA:");
    expect(launchable).toContain(
      "Evidence mode: advisory manual validation; not automated E2E evidence",
    );
    expect(launchable).toContain("Do not use it as automated E2E evidence");
    expect(launchable).toContain(
      "Inference API key exposure approval: approved / denied / not requested",
    );
    expect(launchable).toContain(
      "Inference API key disposition: rotated / revoked / waived / not used",
    );
    expect(launchable).toContain(
      "Do not stop or delete a Brev instance without explicit user approval",
    );
  });

  it("binds image and environment identity before manual validation (#8924)", () => {
    expect(launchable).toContain(
      "`producer.runId` equal to the producer run ID selected by the automated job",
    );
    expect(launchable).toContain("`fullE2e` equal to `passed`");
    expect(launchable).toContain("`boot.bootImage` from `launchable-e2e.json`");
    expect(launchable).toContain("Use the supplied environment ID as the authoritative identity");
    expect(launchable).toContain(
      "Use an instance-name lookup only when no environment ID is available",
    );
    expect(launchable).toContain("validate that environment and do not deploy a replacement");
    expect(launchable).toContain("obtain explicit user approval immediately before deployment");
    expect(launchable).toContain("`not run` only when no required validation check started");
  });

  it("keeps manual Launchable validation separate from automated E2E evidence (#8924)", () => {
    expect(launchable).toContain("This report is advisory manual validation");
    expect(launchable).toContain("Do not use it as automated E2E evidence");
    expect(launchable).toContain("Automated Launchable workflow and job URL");
    expect(guide).toContain("`nemoclaw-maintainer-validate-launchable`");
  });
});

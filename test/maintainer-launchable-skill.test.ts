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
const release = fs.readFileSync(
  path.join(skillsRoot, "nemoclaw-maintainer-cut-release-tag", "SKILL.md"),
  "utf8",
);
const guide = fs.readFileSync(path.join(skillsRoot, "nemoclaw-skills-guide", "SKILL.md"), "utf8");
const releasePolicy = fs.readFileSync(
  path.join(skillsRoot, "nemoclaw-maintainer-policies", "references", "release-train.md"),
  "utf8",
);

describe("staging Launchable maintainer guidance", () => {
  it("keeps browser and inference gaps visible as partial validation (#8924)", () => {
    expect(launchable).toContain(
      "https://brev.nvidia.com/launchable/deploy/now?launchableID=env-3GdbIjswX4fs3VJ6cYRHr5zoQXo",
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
    expect(launchable).toContain("The validation does not revoke the inference credential");
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
      "Inference credential exposure approval: approved / denied / not requested",
    );
    expect(launchable).toContain(
      "Do not stop or delete a Brev instance without explicit user approval",
    );
  });

  it("binds image and environment identity before manual validation (#8924)", () => {
    expect(launchable).toContain(
      "`producer.runId` equal to the producer run ID selected by the publication job",
    );
    expect(launchable).toContain("Use the supplied environment ID as the authoritative identity");
    expect(launchable).toContain(
      "Use an instance-name lookup only when no environment ID is available",
    );
    expect(launchable).toContain("validate that environment and do not deploy a replacement");
    expect(launchable).toContain("obtain explicit user approval immediately before deployment");
    expect(launchable).toContain("`not run` only when no required validation check started");
  });

  it("keeps manual Launchable validation advisory during release tagging (#8924)", () => {
    expect(release).toContain("nemoclaw-maintainer-validate-launchable");
    expect(release).toContain(
      "https://brev.nvidia.com/launchable/deploy/now?launchableID=env-3GdbIjswX4fs3VJ6cYRHr5zoQXo",
    );
    expect(release).toContain("Its absence, partial result, or failure does not block");
    expect(release).toContain(
      "Do not describe successful image publication as successful Launchable, runtime, or inference validation",
    );
    expect(release).toContain(
      "do not assume that the mutable family still points to the candidate",
    );
    expect(release).toContain("temporary-staging-launchable-qualification-policy");
    expect(releasePolicy).toContain("NemoClaw maintainers own this policy");
    expect(releasePolicy).toContain("GitHub retains the workflow logs and artifact");
    expect(releasePolicy).toContain(
      "missing, partial, or failed result needs no per-release waiver",
    );
    expect(releasePolicy).toContain("That successful run is the reactivation evidence");
    expect(guide).toContain("`nemoclaw-maintainer-validate-launchable`");
  });
});

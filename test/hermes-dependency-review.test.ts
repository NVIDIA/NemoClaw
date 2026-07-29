// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.join(import.meta.dirname, "..");
const dockerfileBase = fs.readFileSync(
  path.join(root, "agents", "hermes", "Dockerfile.base"),
  "utf8",
);
const config = fs.readFileSync(
  path.join(root, "agents", "hermes", "config", "hermes-config.ts"),
  "utf8",
);
const manifest = fs.readFileSync(path.join(root, "agents", "hermes", "manifest.yaml"), "utf8");
const wrapper = fs.readFileSync(path.join(root, "agents", "hermes", "hermes-wrapper.py"), "utf8");
const review = fs.readFileSync(
  path.join(root, "docs", "security", "hermes-0.19.0-dependency-review.md"),
  "utf8",
);

function arg(name: string): string {
  const match = dockerfileBase.match(new RegExp(`^ARG ${name}=(.+)$`, "mu"));
  expect(match, `Missing Dockerfile ARG ${name}`).not.toBeNull();
  return match?.[1] ?? "";
}

describe("Hermes 0.19.0 dependency review", () => {
  it("binds every active source identity to the reviewed release", () => {
    expect(arg("HERMES_VERSION")).toBe("v2026.7.20");
    expect(arg("HERMES_SEMVER")).toBe("0.19.0");
    expect(arg("HERMES_TARBALL_SHA256")).toBe(
      "285f3fc134ff466a90065e1517801a68993733b807158ee8f32aa01613786990",
    );
    expect(arg("HERMES_NPM_INTEGRITY")).toBe(
      "sha512-+oVKG3lXbk2kEP+J6BXZjtmSBSaFfczIdOWQ9CUSTdTqq2uyHbk4p+kPyZ6MeGs56JU5qXzMNbqGKRVOQRGC1A==",
    );
    expect(manifest).toContain('expected_version: "0.19.0"');
    expect(review).toContain("`3ef6bbd201263d354fd83ec55b3c306ded2eb72a`");
    expect(review).toContain("`bd0bac012aee38a60894781f4597dc29ee7bedb3448540249921f10d3bef327f`");
    expect(review).toContain("`ac986bede64a2785436676c0ea084ec586574f8cb00a9d047e095b435d3e21c0`");
  });

  it("preserves the reviewed authorization and state migrations", () => {
    expect(config).toContain("_config_version: 33");
    expect(config).toMatch(/approvals:\s*\{\s*[\s\S]*?mode: "manual"/u);
    expect(config).toMatch(/session_reset:\s*\{\s*[\s\S]*?mode: "both"/u);
    expect(config).toMatch(/browser:\s*\{\s*[\s\S]*?restrict_evaluate: true/u);
    expect(config).toMatch(/display:\s*\{\s*[\s\S]*?show_reasoning: false/u);
    expect(config).toMatch(/display:\s*\{\s*[\s\S]*?show_commentary: false/u);
    expect(config).toMatch(/updates:\s*\{\s*[\s\S]*?pre_update_backup: false/u);
    expect(config).toMatch(/updates:\s*\{\s*[\s\S]*?refresh_cua_driver: false/u);
    expect(manifest).toContain("path: cron/executions.db\n    strategy: sqlite_backup");
    expect(manifest).toContain(
      "path: gateway/discord_message_recovery.db\n    strategy: sqlite_backup",
    );
    expect(review).toContain("mcp__server__tool");
    expect(review).toContain("default-profile");
    expect(review).toContain("named-profile");
    expect(review).toContain("`HERMES-13`");
    expect(review).toContain("`HERMES-14`");
    expect(review).toContain("`HERMES-15`");
    expect(review).toContain("`HERMES-16`");
    expect(review).toContain("`HERMES-17`");
    expect(review).toContain("`HERMES-18`");
    expect(review).toContain("Unresolved upgrade-created high-impact concerns: `0`");
  });

  it("keeps wrapper parsing aligned with the target CLI", () => {
    for (const expected of ['"--usage-file"', '"--no-restore-cwd"', '"--safe-mode"', '"console"']) {
      expect(wrapper).toContain(expected);
    }
  });

  it("ships the reviewed multipart remediation and records residual debt", () => {
    expect(dockerfileBase).toContain("python-multipart==0.0.32");
    expect(dockerfileBase).toContain(
      "sha256:be54b7f3fa167bb83e4fcd936b887b708f4e57fe75911c02aebf53efaf8d938e",
    );
    expect(dockerfileBase).toContain(
      "sha256:ff6d3f776f16878c894e52e107296ffc890e913c611b1a4ec6c44e2821fe2e23",
    );
    for (const advisory of ["GHSA-5rvq-cxj2-64vf", "GHSA-6jv3-5f52-599m", "GHSA-v9pg-7xvm-68hf"]) {
      expect(review).toContain(advisory);
    }
    expect(review).toContain("Pillow `12.2.0`");
    expect(review).toContain("Starlette `1.0.1`");
    expect(review).toContain("zero critical");
  });
});

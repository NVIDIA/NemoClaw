// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Regression guards for sandbox image provisioning.
//
// Verifies that the image-build sources (Dockerfile and Dockerfile.base)
// preserve the runtime-writable symlink layout introduced by #1027/#1519
// and the root-owned read-only config invariants from #514.
//
// These are static regression guards over the Dockerfile text — they fail
// immediately if a future refactor drops one of the baked-in provisioning
// steps, even before a full image build runs in CI.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const DOCKERFILE = path.join(ROOT, "Dockerfile");
const DOCKERFILE_BASE = path.join(ROOT, "Dockerfile.base");
const DOCKERFILE_SANDBOX = path.join(ROOT, "test", "Dockerfile.sandbox");

describe("sandbox provisioning: exec-approvals / update-check symlinks (#1027, #1519)", () => {
  const src = fs.readFileSync(DOCKERFILE_BASE, "utf-8");

  it("Dockerfile.base creates the exec-approvals.json backing file in .openclaw-data", () => {
    // The data file has to exist before the symlink target resolves, so the
    // OpenClaw gateway can read+write through .openclaw/exec-approvals.json
    // without hitting EACCES.
    expect(src).toMatch(/touch \/sandbox\/\.openclaw-data\/exec-approvals\.json/);
  });

  it("Dockerfile.base symlinks .openclaw/exec-approvals.json -> .openclaw-data/exec-approvals.json", () => {
    expect(src).toContain(
      "ln -s /sandbox/.openclaw-data/exec-approvals.json /sandbox/.openclaw/exec-approvals.json",
    );
  });

  it("Dockerfile.base creates the update-check.json backing file in .openclaw-data", () => {
    expect(src).toMatch(/touch \/sandbox\/\.openclaw-data\/update-check\.json/);
  });

  it("Dockerfile.base symlinks .openclaw/update-check.json -> .openclaw-data/update-check.json", () => {
    expect(src).toContain(
      "ln -s /sandbox/.openclaw-data/update-check.json /sandbox/.openclaw/update-check.json",
    );
  });

  it("the exec-approvals data file is created before the symlink that points at it", () => {
    const dataIdx = src.indexOf("touch /sandbox/.openclaw-data/exec-approvals.json");
    const linkIdx = src.indexOf(
      "ln -s /sandbox/.openclaw-data/exec-approvals.json /sandbox/.openclaw/exec-approvals.json",
    );
    expect(dataIdx).toBeGreaterThanOrEqual(0);
    expect(linkIdx).toBeGreaterThan(dataIdx);
  });
});

describe("sandbox provisioning: procps debug tools (#2343)", () => {
  const baseSrc = fs.readFileSync(DOCKERFILE_BASE, "utf-8");
  const mainSrc = fs.readFileSync(DOCKERFILE, "utf-8");

  it("Dockerfile.base installs procps in the apt-get layer", () => {
    expect(baseSrc).toMatch(/apt-get.*install.*procps/s);
  });

  it("Dockerfile has a procps fallback for stale GHCR base images", () => {
    // The hardening step must protect procps from autoremove and install it
    // if the base image predates the procps addition.
    expect(mainSrc).toMatch(/command -v ps/);
    expect(mainSrc).toMatch(/install.*procps/);
  });
});

describe("sandbox provisioning: root-owned read-only config (#514)", () => {
  const src = fs.readFileSync(DOCKERFILE, "utf-8");

  it("openclaw.json stays mode 0444 (agent cannot tamper with auth token / CORS)", () => {
    expect(src).toContain("chmod 444 /sandbox/.openclaw/openclaw.json");
  });

  it(".config-hash stays root:root 0444 (agent cannot forge a matching integrity hash)", () => {
    expect(src).toContain("chown root:root /sandbox/.openclaw/.config-hash");
    expect(src).toContain("chmod 444 /sandbox/.openclaw/.config-hash");
  });

  it(".openclaw directory stays root:root 0755 (agent cannot add or replace symlinks)", () => {
    expect(src).toContain("chown root:root /sandbox/.openclaw");
    expect(src).toContain("chmod 755 /sandbox/.openclaw");
  });
});

describe("sandbox provisioning: codex-acp wrapper (#2484)", () => {
  const dockerSrc = fs.readFileSync(DOCKERFILE, "utf-8");
  const wrapperSrc = fs.readFileSync(path.join(ROOT, "scripts", "codex-acp-wrapper.sh"), "utf-8");

  it("copies the wrapper into the sandbox image", () => {
    expect(dockerSrc).toContain(
      "COPY scripts/codex-acp-wrapper.sh /usr/local/bin/nemoclaw-codex-acp",
    );
    expect(dockerSrc).toContain("/usr/local/bin/nemoclaw-codex-acp");
  });

  it("runs codex-acp with writable Codex and XDG state", () => {
    expect(wrapperSrc).toContain("export CODEX_HOME=");
    expect(wrapperSrc).toContain("export XDG_CONFIG_HOME=");
    expect(wrapperSrc).toContain("export HOME=");
    expect(wrapperSrc).toContain("exec /usr/local/bin/codex-acp");
  });
});

describe("sandbox test image fixtures", () => {
  const src = fs.readFileSync(DOCKERFILE_SANDBOX, "utf-8");

  it("clears production config recovery artifacts after writing the legacy fixture", () => {
    expect(src).toContain("/sandbox/.openclaw/openclaw.json.bak*");
    expect(src).toContain("/sandbox/.openclaw/openclaw.json.last-good");
    expect(src).toContain("/sandbox/.openclaw-data/logs/config-health.json");
  });
});

describe("sandbox operations E2E harness", () => {
  const src = fs.readFileSync(
    path.join(ROOT, "test", "e2e", "test-sandbox-operations.sh"),
    "utf-8",
  );

  it("resumes onboard when OpenShell resets after importing the image", () => {
    expect(src).toContain("is_onboard_import_stream_reset");
    expect(src).toContain("Connection reset by peer (os error 104)");
    expect(src).toContain("nemoclaw onboard --resume --non-interactive");
  });
});

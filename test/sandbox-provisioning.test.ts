// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Regression guards for sandbox image provisioning.
//
// Verifies that the image-build sources (Dockerfile and Dockerfile.base)
// preserve the mutable-by-default config layout (#2227) and the gateway
// auth token externalization (#2378).
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

describe("sandbox provisioning: unified .openclaw layout (#2227)", () => {
  const src = fs.readFileSync(DOCKERFILE_BASE, "utf-8");

  it("Dockerfile.base creates exec-approvals.json directly in .openclaw (no symlink)", () => {
    expect(src).toMatch(/touch \/sandbox\/\.openclaw\/exec-approvals\.json/);
  });

  it("Dockerfile.base creates update-check.json directly in .openclaw (no symlink)", () => {
    expect(src).toMatch(/touch \/sandbox\/\.openclaw\/update-check\.json/);
  });

  it("Dockerfile.base does not create .openclaw-data directories (old split layout removed)", () => {
    // Comments may mention .openclaw-data for context; check for actual mkdir/touch/ln usage
    expect(src).not.toMatch(/mkdir.*\.openclaw-data/);
    expect(src).not.toMatch(/touch.*\.openclaw-data/);
    expect(src).not.toMatch(/ln -s.*\.openclaw-data/);
  });

  it("Dockerfile.base sets .openclaw to sandbox:sandbox ownership (mutable by default)", () => {
    expect(src).toMatch(/chown -R sandbox:sandbox \/sandbox\/\.openclaw/);
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

describe("sandbox provisioning: gateway auth token externalization (#2378)", () => {
  const src = fs.readFileSync(DOCKERFILE, "utf-8");

  it("Dockerfile clears any auto-generated gateway auth token from openclaw.json", () => {
    // The real token is generated at container startup by generate_gateway_token()
    expect(src).toMatch(/\['token'\]\s*=\s*''/);
  });

  it("Dockerfile does NOT bake a persistent auth token into openclaw.json", () => {
    // Negative guard: the old pattern of writing a real token at build time
    // must not reappear. The token is runtime-only.
    expect(src).not.toMatch(/gateway_token.*=.*secrets\./);
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

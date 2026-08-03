// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
const PATCH_PATH = path.join(ROOT, "agents", "hermes", "whatsapp-proxy.patch");
const DOCKERFILE_PATH = path.join(ROOT, "agents", "hermes", "Dockerfile.base");
const REVIEW_PATH = path.join(ROOT, "docs", "security", "hermes-0.19.0-dependency-review.md");

const patch = fs.readFileSync(PATCH_PATH, "utf8");
const dockerfile = fs.readFileSync(DOCKERFILE_PATH, "utf8");
const review = fs.readFileSync(REVIEW_PATH, "utf8");

describe("Hermes WhatsApp proxy patch (#8087)", () => {
  it("routes only NemoClaw's injected HTTPS proxy through both Baileys agents", () => {
    expect(patch).toContain("+import { HttpsProxyAgent } from 'https-proxy-agent';");
    expect(patch).toContain("+const PROXY_AGENT = process.env.HTTPS_PROXY");
    expect(patch).toContain("+  ? new HttpsProxyAgent(process.env.HTTPS_PROXY)");
    expect(patch.match(/^\+    agent: PROXY_AGENT,$/gmu)).toHaveLength(1);
    expect(patch.match(/^\+    fetchAgent: PROXY_AGENT,$/gmu)).toHaveLength(1);
    expect(patch).not.toContain("WHATSAPP_PROXY");
    expect(patch).not.toContain("HTTP_PROXY");
  });

  it("locks the reviewed proxy dependency and its transitive graph", () => {
    expect(patch).toContain('+    "https-proxy-agent": "7.0.6",');
    expect(patch).toContain(
      '+      "integrity": "sha512-vK9P5/iUfdl95AI+JVyUuIcVtd4ofvtrOr3HNtM2yxC9bnMbEdp3x01OhQNnjb8IJYi38VlTE3mBXwcfvywuSw==",',
    );
    for (const dependency of ["agent-base", "debug", "ms"]) {
      expect(patch).toContain(`node_modules/${dependency}`);
    }
  });

  it("fails the base build if the pinned source or installed agent drifts", () => {
    const copyIndex = dockerfile.indexOf(
      "COPY agents/hermes/whatsapp-proxy.patch /tmp/hermes-whatsapp-proxy.patch",
    );
    const checkIndex = dockerfile.indexOf(
      "git -C /opt/hermes apply --check /tmp/hermes-whatsapp-proxy.patch",
    );
    const applyIndex = dockerfile.indexOf(
      "git -C /opt/hermes apply /tmp/hermes-whatsapp-proxy.patch",
    );
    const installIndex = dockerfile.indexOf('npm ci --prefix "${bridge_dir}"');
    const probeIndex = dockerfile.indexOf(
      'const { HttpsProxyAgent } = require("./scripts/whatsapp-bridge/node_modules/https-proxy-agent")',
    );

    expect(copyIndex).toBeGreaterThanOrEqual(0);
    expect(checkIndex).toBeGreaterThan(copyIndex);
    expect(applyIndex).toBeGreaterThan(checkIndex);
    expect(installIndex).toBeGreaterThan(applyIndex);
    expect(probeIndex).toBeGreaterThan(installIndex);
    expect(dockerfile).toContain('agent.proxy.href !== "http://127.0.0.1:3128/"');
  });

  it("records the added graph and remaining protected runtime gate", () => {
    expect(review).toContain("`https-proxy-agent@7.0.6`");
    expect(review).toContain("`agent-base@7.1.4`");
    expect(review).toContain("`HERMES-22`");
    expect(review).toContain("protected Hermes WhatsApp E2E evidence");
  });
});

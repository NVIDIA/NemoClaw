// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { googlechatManifest } from "./manifest";

const googlechatPolicy = readFileSync(new URL("./policy/openclaw.yaml", import.meta.url), "utf8");

// Locks the sandbox-runtime security contract the Google Chat channel depends on:
// the two boot preloads that keep the private key out of the sandbox and route
// googleapis calls through the trusted proxy, plus the reload-off and sentinel
// fragments that make a dropped preload fail loudly instead of leaking. The pinned
// @openclaw/googlechat bundle is fetched at sandbox-build time (not in node_modules),
// so drift in the bundle itself belongs to build/E2E; these assertions cover the
// wiring a refactor could otherwise weaken silently in the unit lane.

function renderFragmentValue(path: string): Record<string, unknown> {
  const entry = googlechatManifest.render.find((fragment) => fragment.fragment.path === path);
  return (entry?.fragment.value ?? {}) as Record<string, unknown>;
}

describe("googlechat runtime security contract", () => {
  it("delivers no credentials into the sandbox", () => {
    expect(googlechatManifest.credentials).toEqual([]);
  });

  it("renders a non-existent serviceAccountFile sentinel, not a real key path", () => {
    const channel = renderFragmentValue("channels.googlechat");
    expect(channel.serviceAccountFile).toBe(
      "/nonexistent/googlechat-gateway-minted-no-service-account-file",
    );
  });

  it("suppresses gateway hot-reload so the webhook route survives self-writes", () => {
    expect(renderFragmentValue("gateway.reload")).toEqual({ mode: "off" });
  });

  it("requires both outbound-security boot preloads and marks them non-optional", () => {
    const preloads = googlechatManifest.runtime?.openclaw?.nodePreloads;
    expect(preloads).toBeDefined();
    for (const module of ["googlechat-trusted-proxy-fetch", "googlechat-outbound-auth"]) {
      const preload = preloads?.find((entry) => entry.module === module);
      expect(preload, `missing required preload ${module}`).toBeDefined();
      expect(preload?.optional).toBe(false);
      expect(preload?.injectInto).toContain("boot");
    }
  });

  it("keeps credential rewriting out of Google Chat request bodies", () => {
    expect(googlechatPolicy).not.toContain("request_body_credential_rewrite");
  });
});

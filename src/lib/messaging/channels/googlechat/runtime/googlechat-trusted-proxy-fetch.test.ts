// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { outboundAuthPatchInternals } from "./googlechat-outbound-auth";
import { trustedProxyFetchPatchInternals } from "./googlechat-trusted-proxy-fetch";

type CommonJsLoader = (
  this: unknown,
  mod: { _compile: (source: string, filename: string) => unknown },
  filename: string,
) => unknown;

const { patchSource, isPatchError, isOpenClawGooglechatFile, createComposableJsLoader } =
  trustedProxyFetchPatchInternals as {
    patchSource: (source: string, filename: string) => string;
    isPatchError: (reason: unknown) => boolean;
    isOpenClawGooglechatFile: (filename: string) => boolean;
    createComposableJsLoader: (loader: CommonJsLoader) => CommonJsLoader;
  };
const { createComposableJsLoader: createOutboundAuthJsLoader } = outboundAuthPatchInternals as {
  createComposableJsLoader: (loader: CommonJsLoader) => CommonJsLoader;
};

const FILE = "/x/node_modules/@openclaw/googlechat/dist/api-XXXX.js";
const PATCH_MARKER = "nemoclaw:gc-trusted-proxy";

// Representative slice of the plugin's google-auth/api bundle carrying all three
// fetch call sites the patch targets, plus the BUNDLE_MARKER that identifies it.
const BUNDLE = [
  'const GOOGLE_AUTH_AUDIT_CONTEXT = "googlechat.auth";',
  "function createGoogleAuthFetch(opts) {",
  "  return fetchWithSsrFGuard({",
  "    auditContext: GOOGLE_AUTH_AUDIT_CONTEXT,",
  "    dispatcherPolicy: opts.dispatcherPolicy,",
  "  });",
  "}",
  "function fetchChatCerts() {",
  "  return fetchWithSsrFGuard({",
  "    url: CHAT_CERTS_URL,",
  '    auditContext: "googlechat.auth.certs",',
  "  });",
  "}",
  "function withGoogleChatResponse(url, init) {",
  "  return fetchWithSsrFGuard({",
  "    url,",
  "    init,",
  "  });",
  "}",
  "async function getGoogleChatAccessToken(account) {",
  "  return (await account.auth.getClient()).getAccessToken();",
  "}",
].join("\n");

describe("googlechat trusted-proxy-fetch patch", () => {
  it("matches the external-extension install path, not only the package path", () => {
    // Bundled/package load path (pre-2026.6.10).
    expect(
      isOpenClawGooglechatFile("/x/node_modules/@openclaw/googlechat/dist/channel.adapters-A.js"),
    ).toBe(true);
    // External-extension install path (openclaw plugins install → 2026.6.10 sandbox).
    expect(
      isOpenClawGooglechatFile(
        "/sandbox/.openclaw/extensions/googlechat/dist/channel.adapters-DqnXEL1u.js",
      ),
    ).toBe(true);
    // Other channels and non-.js files stay untouched.
    expect(isOpenClawGooglechatFile("/sandbox/.openclaw/extensions/slack/dist/index.js")).toBe(
      false,
    );
    expect(isOpenClawGooglechatFile("/x/extensions/googlechat/dist/index.ts")).toBe(false);
  });

  it("rewrites all three googleapis fetch sites when the bundle matches", () => {
    const patched = patchSource(BUNDLE, FILE);
    expect(patched).not.toBe(BUNDLE);
    expect(patched).toContain(PATCH_MARKER);
    // Site A: proxy-mode-conditional spread injected.
    expect(patched).toContain('.dispatcherPolicy?.mode === "explicit-proxy"');
    // Both trusted modes appear (Site A ternary + Sites B/C).
    expect(patched).toContain("trusted_explicit_proxy");
    expect(patched).toContain("trusted_env_proxy");
  });

  it("maps Site A explicit-proxy to trusted_explicit_proxy and keeps the dispatcherPolicy", () => {
    const patched = patchSource(BUNDLE, FILE);
    expect(patched).toContain(
      '...(opts.dispatcherPolicy?.mode === "explicit-proxy" ' +
        '? { mode: "trusted_explicit_proxy", dispatcherPolicy: opts.dispatcherPolicy } ' +
        ': { mode: "trusted_env_proxy" })',
    );
  });

  it("adds trusted_env_proxy to Site B (fetchChatCerts) and Site C (outbound wrapper)", () => {
    const patched = patchSource(BUNDLE, FILE);
    // Site B: mode inserted between the url and auditContext of the certs fetch.
    expect(patched).toContain('url: CHAT_CERTS_URL, mode: "trusted_env_proxy",');
    // Site C: mode inserted at the head of the outbound-wrapper options.
    expect(patched).toMatch(/fetchWithSsrFGuard\(\{\s*mode: "trusted_env_proxy",\s*url,/);
  });

  it("is idempotent — already-patched source is returned unchanged", () => {
    const once = patchSource(BUNDLE, FILE);
    expect(patchSource(once, FILE)).toBe(once);
  });

  it("passes through files that are not the google-auth/api bundle", () => {
    const other = "export function unrelated() {\n  return fetchWithSsrFGuard({ url, });\n}";
    expect(patchSource(other, FILE)).toBe(other);
  });

  it("throws naming the drifted anchor when a call site is missing", () => {
    // Bundle marker present + Sites A/B, but the outbound wrapper (Site C) drifted away.
    const drift = BUNDLE.replace(
      "function withGoogleChatResponse(url, init) {\n  return fetchWithSsrFGuard({\n    url,\n    init,\n  });\n}",
      "",
    );
    expect(() => patchSource(drift, FILE)).toThrow(/withGoogleChatResponse outbound fetch/);
    expect(() => patchSource(drift, FILE)).toThrow(/not recognized/);
    let caught: unknown;
    try {
      patchSource(drift, FILE);
    } catch (error) {
      caught = error;
    }
    expect(isPatchError(caught)).toBe(true);
  });

  it("isPatchError distinguishes anchor-drift errors from unrelated ones", () => {
    expect(isPatchError(new Error("some unrelated failure"))).toBe(false);
    expect(
      isPatchError(
        new Error("OpenClaw Google Chat trusted-proxy fetch anchors not recognized in x.js [..]"),
      ),
    ).toBe(true);
  });

  it.each([
    ["trusted proxy then outbound auth", createOutboundAuthJsLoader, createComposableJsLoader],
    ["outbound auth then trusted proxy", createComposableJsLoader, createOutboundAuthJsLoader],
  ])("composes the CommonJS rewrites in either preload order: %s", (_label, outer, inner) => {
    let compiledSource = "";
    const mod = {
      _compile(source: string) {
        compiledSource = source;
      },
    };
    const baseLoader: CommonJsLoader = (loadedModule, filename) =>
      loadedModule._compile(BUNDLE, filename);

    outer(inner(baseLoader))(mod, FILE);

    expect(compiledSource).toContain(PATCH_MARKER);
    expect(compiledSource).toContain(
      "nemoclaw: googlechat outbound bearer via gateway-minted credential",
    );
  });
});

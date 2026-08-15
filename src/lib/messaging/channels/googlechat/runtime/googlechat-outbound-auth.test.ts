// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { outboundAuthPatchInternals } from "./googlechat-outbound-auth";

// The self-installing preload publishes its pure helpers here on require (above).
const { patchSource, buildShortCircuit, isPatchError, isOpenClawGooglechatFile } =
  outboundAuthPatchInternals as {
    patchSource: (source: string, filename: string) => string;
    buildShortCircuit: () => string;
    isPatchError: (reason: unknown) => boolean;
    isOpenClawGooglechatFile: (filename: string) => boolean;
  };

const FILE = "/x/node_modules/@openclaw/googlechat/dist/auth.js";
const CALL_MARKER = "nemoclaw: googlechat outbound bearer via gateway-minted credential";
const CANONICAL = "openshell:resolve:env:GOOGLE_CHAT_ACCESS_TOKEN";
// A representative slice of the plugin's token producer.
const PLUGIN_SRC =
  "async function getGoogleChatAccessToken(account) {\n" +
  "  const client = await auth.getClient();\n" +
  "  return (await client.getAccessToken()).token;\n" +
  "}";

describe("googlechat outbound-auth patch", () => {
  it("matches the external-extension install path, not only the package path", () => {
    // Bundled/package load path (pre-2026.6.10).
    expect(isOpenClawGooglechatFile("/x/node_modules/@openclaw/googlechat/dist/auth.js")).toBe(
      true,
    );
    // External-extension install path (openclaw plugins install → 2026.6.10 sandbox).
    expect(isOpenClawGooglechatFile("/sandbox/.openclaw/extensions/googlechat/dist/auth.js")).toBe(
      true,
    );
    // Other channels and non-.js files stay untouched.
    expect(isOpenClawGooglechatFile("/sandbox/.openclaw/extensions/slack/dist/index.js")).toBe(
      false,
    );
    expect(isOpenClawGooglechatFile("/x/extensions/googlechat/dist/index.ts")).toBe(false);
  });

  it("rewrites the token producer when the anchor matches", () => {
    const patched = patchSource(PLUGIN_SRC, FILE);
    expect(patched).not.toBe(PLUGIN_SRC);
    expect(patched).toContain(CALL_MARKER);
    // The short-circuit is injected at the TOP of the body; the original body is
    // left in place (now unreachable) rather than deleted.
    expect(patched).toContain("auth.getClient()");
    expect(patched.indexOf(CALL_MARKER)).toBeLessThan(patched.indexOf("auth.getClient()"));
  });

  it("is idempotent — already-patched source is returned unchanged", () => {
    const once = patchSource(PLUGIN_SRC, FILE);
    expect(patchSource(once, FILE)).toBe(once);
  });

  it("passes through files that do not define the producer", () => {
    const other = "export function somethingElse() {\n  return 1;\n}";
    expect(patchSource(other, FILE)).toBe(other);
  });

  it("throws a named patch error when the definition drifts", () => {
    // Contains the definition substring but not the expected callable shape.
    const drift = "// references function getGoogleChatAccessToken in a comment only";
    expect(() => patchSource(drift, FILE)).toThrow(/shape not recognized/);
    let caught: unknown;
    try {
      patchSource(drift, FILE);
    } catch (error) {
      caught = error;
    }
    expect(isPatchError(caught)).toBe(true);
  });

  it("isPatchError distinguishes drift errors from unrelated ones", () => {
    expect(isPatchError(new Error("some unrelated failure"))).toBe(false);
    expect(
      isPatchError(
        new Error(
          "OpenClaw Google Chat getGoogleChatAccessToken definition shape not recognized in x.js",
        ),
      ),
    ).toBe(true);
  });

  describe("injected short-circuit runtime behavior", () => {
    const ENV = "GOOGLE_CHAT_ACCESS_TOKEN";

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    // Build a callable from the patched producer whose original body returns a
    // sentinel, so we can prove the injected guard runs before (and instead of) it.
    function buildProducer(): () => string {
      const patched = patchSource(
        'function getGoogleChatAccessToken(account) { return "IN_PROCESS_MINT"; }',
        FILE,
      );
      return new Function(`${patched}\n return getGoogleChatAccessToken;`)() as () => string;
    }

    it("returns the revision-less canonical placeholder when a stamped placeholder is set", () => {
      vi.stubEnv(ENV, "openshell:resolve:env:v7_GOOGLE_CHAT_ACCESS_TOKEN");
      expect(buildProducer()()).toBe(CANONICAL);
    });

    it("returns a raw (non-placeholder) env value as-is for manual deployments", () => {
      vi.stubEnv(ENV, "ya29.raw-access-token");
      expect(buildProducer()()).toBe("ya29.raw-access-token");
    });

    it("throws (never reaches the in-process body) when the env is unset", () => {
      vi.stubEnv(ENV, undefined);
      const producer = buildProducer();
      expect(producer).toThrow(/GOOGLE_CHAT_ACCESS_TOKEN is not set/);
    });
  });

  it("buildShortCircuit emits the canonical placeholder and the fail-closed throw", () => {
    const src = buildShortCircuit();
    expect(src).toContain(`"${CANONICAL}"`);
    expect(src).toContain("throw new Error");
    expect(src).toContain(CALL_MARKER);
  });
});

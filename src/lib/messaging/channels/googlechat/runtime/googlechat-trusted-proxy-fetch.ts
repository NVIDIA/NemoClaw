// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// googlechat-trusted-proxy-fetch.ts — load-time patch that routes the Google
// Chat plugin's googleapis fetches through the TRUSTED ENV PROXY instead of
// resolving hostnames locally. It replaces the earlier DNS-resolve shim, which
// answered the googleapis hosts with a public sentinel IP so the SSRF gate's
// local getaddrinfo would pass; that shim has been removed.
//
// ── Workaround Analysis ──────────────────────────────────────────────────────
// 1. What:  rewrites the plugin's three googleapis fetch call sites (dist bundle)
//           to a trusted guard mode so they route by hostname through the env proxy.
// 2. Why:   the sandbox netns is DNS-less; the plugin's fetches default to STRICT
//           SSRF mode (local getaddrinfo), which fails EAI_AGAIN with no local DNS.
// 3. Alts:  no config/env toggle exists to request trusted mode; the prior
//           DNS-sentinel-IP shim was removed as hackier; upstream fix (5) unshipped.
// 4. Risk:  version-sensitive (keys on bundle anchors) but bounded — plugin is
//           integrity-version-pinned, anchors are unit-tested, and drift fails loud
//           (named patch error), never a silent downgrade; Google hosts only, so no
//           SSRF widening.
// 5. Exit:  upstream @openclaw/googlechat requests trusted-env-proxy mode under a
//           managed/env proxy (mirror of web_fetch openclaw#50650) — see below.
//
// ── The story: what this changes, and why ────────────────────────────────────
// The sandbox netns is DNS-less BY DESIGN — all name resolution and egress go
// through the L7 proxy (10.200.0.1:3128). OpenClaw's SSRF fetch guard
// (`fetchWithSsrFGuard`) defaults to STRICT mode, which does a LOCAL
// `getaddrinfo` (SSRF IP-pinning) before connecting. In the DNS-less netns that
// local lookup fails with EAI_AGAIN, so every googleapis fetch dies.
//
// The guard already supports the correct behavior via `mode: "trusted_env_proxy"`:
// it SKIPS the local resolve, keeps the pre-DNS hostname/policy checks, and hands
// the hostname to the env proxy (which resolves + enforces policy). But the
// @openclaw/googlechat plugin does not request that mode:
//   • createGoogleAuthFetch() (inbound cert verify + google-auth) passes a proxy
//     `dispatcherPolicy` (gaxios injects an env-derived proxy agent, so the mode
//     is "explicit-proxy"); the guard's plain `canUseTrustedEnvProxy` gate
//     requires `!dispatcherPolicy`, so it falls to the local-resolve pin branch.
//   • fetchChatCerts() (inbound chat-cert verify) and withGoogleChatResponse()
//     (ALL outbound sends/edits/uploads) pass neither `mode` nor a policy, so
//     they default to STRICT + local resolve too.
//
// This preload rewrites those three call sites in the plugin's dist bundle to a
// trusted guard mode (see the per-site mapping below): explicit-proxy →
// `trusted_explicit_proxy` (keep the dispatcherPolicy), otherwise
// `trusted_env_proxy`. The guard's own `shouldUseEnvHttpProxyForUrl` /
// explicit-proxy checks mean the trusted path only activates when a proxy is
// actually configured (the sandbox); outside a proxy (dev/CI) it degrades to the
// normal pinned path, so behavior is unchanged there. All three call sites target
// Google hosts only (google-auth is confined by GOOGLE_AUTH_POLICY; the others
// hit fixed googleapis/chat URLs), so this does not broaden SSRF exposure for any
// user-influenced URL.
//
// Net effect: inbound cert verification and outbound replies both route by
// hostname through the trusted proxy — no local getaddrinfo, no sentinel IP.
//
// ── Long-term fix (remove this once it lands) ─────────────────────────────────
// This is exactly the upstream OpenClaw change (mirror of web_fetch openclaw#50650):
// make @openclaw/googlechat's createGoogleAuthFetch / fetchChatCerts / outbound
// request wrapper use trusted-env-proxy mode under a managed/env proxy. When that
// ships, delete this preload and its `runtime.openclaw.nodePreloads` entry.
//
// Mechanism mirrors slack-channel-guard.ts / googlechat-outbound-auth.ts
// (load-time source rewrite of the @openclaw/googlechat dist bundle via the
// module loader hooks). It targets the SAME dist chunk that
// googlechat-outbound-auth already patches, so the CommonJS wrappers compose via
// Module._compile and both transforms apply regardless of preload order.

// Test seam: the self-installing IIFE below publishes its pure source-rewrite
// helpers here so unit tests can exercise the anchor rewrites, drift handling, and
// idempotency directly. Requiring this module still installs the loader hooks, but
// that install is inert for files outside @openclaw/googlechat.
type CommonJsModuleLike = {
  _compile?: (source: unknown, filename?: string) => unknown;
};

type CommonJsLoader = (
  this: unknown,
  mod: CommonJsModuleLike,
  filename: string,
  ...args: unknown[]
) => unknown;

type ModuleLoadResult = Record<string, unknown> & { source?: unknown };
type NextModuleLoad = (urlValue: string, context: unknown) => ModuleLoadResult;

type TrustedProxyFetchPatchInternals = {
  patchSource: (source: string, filename: string) => string;
  isPatchError: (reason: unknown) => boolean;
  isOpenClawGooglechatFile: (filename: unknown) => boolean;
  createComposableJsLoader: (loader: CommonJsLoader) => CommonJsLoader;
};

export const trustedProxyFetchPatchInternals = {} as TrustedProxyFetchPatchInternals;

(function () {
  "use strict";

  // Idempotency / shape markers.
  var PATCH_MARKER = "nemoclaw:gc-trusted-proxy";
  // Only the dist chunk that defines the google-auth fetch factory is a target;
  // this constant is defined right beside it, so its presence identifies the bundle.
  var BUNDLE_MARKER = "GOOGLE_AUTH_AUDIT_CONTEXT";

  var processWithPatchMarker = process as NodeJS.Process & {
    __nemoclawGooglechatTrustedProxyFetchInstalled?: boolean;
  };
  if (processWithPatchMarker.__nemoclawGooglechatTrustedProxyFetchInstalled) return;
  try {
    Object.defineProperty(
      processWithPatchMarker,
      "__nemoclawGooglechatTrustedProxyFetchInstalled",
      {
        value: true,
      },
    );
  } catch (_e) {
    processWithPatchMarker.__nemoclawGooglechatTrustedProxyFetchInstalled = true;
  }

  function isOpenClawGooglechatFile(filename: unknown): boolean {
    var normalized = String(filename || "").replace(/\\/g, "/");
    if (!normalized.endsWith(".js")) return false;
    // The plugin loads either from a package path (/@openclaw/googlechat/) or, when
    // installed as an external extension (openclaw plugins install), flat from
    // ~/.openclaw/extensions/googlechat/dist/. Match both; the BUNDLE_MARKER gate in
    // patchTrustedProxyFetchSource still confines the rewrite to the google-auth chunk.
    return (
      normalized.indexOf("/@openclaw/googlechat/") !== -1 ||
      normalized.indexOf("/extensions/googlechat/") !== -1
    );
  }

  // Site A — createGoogleAuthFetch: the guarded fetch passes an env-proxy
  // dispatcherPolicy that blocks the trusted-env gate. When the resolved policy
  // is env-proxy, request trusted-env-proxy mode and drop the dispatcherPolicy so
  // the guard skips the local resolve; otherwise leave the call untouched.
  var ANCHOR_A = /dispatcherPolicy:\s*([A-Za-z_$][\w$]*)\.dispatcherPolicy\s*,/;

  // Site B — fetchChatCerts: STRICT + no dispatcherPolicy. Add trusted-env-proxy mode.
  var ANCHOR_B = /(url:\s*CHAT_CERTS_URL\s*,)(\s*auditContext:\s*"googlechat\.auth\.certs")/;

  // Site C — withGoogleChatResponse (the single outbound wrapper): STRICT + no
  // dispatcherPolicy. Add trusted-env-proxy mode at the head of the options.
  // Matched by the `url` shorthand immediately after the call open-brace, which
  // uniquely identifies this call (the google-auth call opens with auditContext).
  var ANCHOR_C = /fetchWithSsrFGuard\(\{(\s*)url\s*,/;

  function patchTrustedProxyFetchSource(source: string, filename: string): string {
    // Not the plugin's google-auth/api bundle — pass through untouched.
    if (source.indexOf(BUNDLE_MARKER) === -1) return source;
    // Already patched (idempotent across repeated --require of this preload).
    if (source.indexOf(PATCH_MARKER) !== -1) return source;

    var missing: string[] = [];
    if (!ANCHOR_A.test(source)) missing.push("createGoogleAuthFetch dispatcherPolicy");
    if (!ANCHOR_B.test(source)) missing.push("fetchChatCerts (googlechat.auth.certs)");
    if (!ANCHOR_C.test(source)) missing.push("withGoogleChatResponse outbound fetch");
    if (missing.length > 0) {
      // The bundle defines the google-auth factory but one or more call sites
      // drifted (e.g. a new plugin version). Fail loud rather than silently
      // leave any googleapis fetch on the local-resolve path (which would break
      // once the DNS shim is retired).
      throw new Error(
        "OpenClaw Google Chat trusted-proxy fetch anchors not recognized in " +
          filename +
          " [" +
          missing.join("; ") +
          "]; trusted-proxy-fetch patch not applied",
      );
    }

    var patched = source;
    // Site A (createGoogleAuthFetch): the google-auth transport carries a proxy
    // dispatcherPolicy derived from HTTPS_PROXY. gaxios injects a proxy AGENT, so
    // resolveGoogleAuthDispatcherPolicy returns mode "explicit-proxy" (not
    // "env-proxy"). Map each proxy mode to its trusted (no-local-resolve) guard
    // mode: explicit-proxy → trusted_explicit_proxy (KEEP the dispatcherPolicy,
    // which sets allowPrivateProxy for the 10.200.0.1 proxy); anything else
    // (env-proxy / direct / none) → trusted_env_proxy (drop the dispatcherPolicy;
    // the guard's shouldUseEnvHttpProxyForUrl gate uses HTTPS_PROXY, which the
    // sandbox always sets). Both branches skip the STRICT local getaddrinfo.
    patched = patched.replace(
      ANCHOR_A,
      '...($1.dispatcherPolicy?.mode === "explicit-proxy" ' +
        '? { mode: "trusted_explicit_proxy", dispatcherPolicy: $1.dispatcherPolicy } ' +
        ': { mode: "trusted_env_proxy" }), /* ' +
        PATCH_MARKER +
        " */",
    );
    // Site B (fetchChatCerts) + Site C (withGoogleChatResponse outbound): STRICT,
    // no dispatcherPolicy → just request trusted_env_proxy (guard skips the local
    // resolve when HTTPS_PROXY is configured; degrades to the normal pinned path
    // otherwise).
    patched = patched.replace(ANCHOR_B, '$1 mode: "trusted_env_proxy",$2');
    patched = patched.replace(ANCHOR_C, 'fetchWithSsrFGuard({$1mode: "trusted_env_proxy",$1url,');
    // Confirm the rewrite actually happened (the "active" banner only proves the
    // loader hook was installed, not that a file was patched).
    process.stderr.write(
      "[channels] [googlechat] trusted-proxy-fetch: rewrote googleapis fetch sites in " +
        filename +
        "\n",
    );
    return patched;
  }

  function errorMessage(reason: unknown): string {
    if (typeof reason === "object" && reason !== null && "message" in reason) {
      return String(Reflect.get(reason, "message") ?? "");
    }
    return String(reason ?? "");
  }

  function isTrustedProxyFetchPatchError(reason: unknown): boolean {
    var msg = errorMessage(reason);
    return (
      msg.indexOf("OpenClaw Google Chat trusted-proxy fetch anchors") !== -1 &&
      msg.indexOf("not recognized") !== -1
    );
  }

  function fileNameFromModuleUrl(urlValue: unknown): string {
    if (typeof urlValue !== "string" || !urlValue.startsWith("file:")) return "";
    try {
      return require("url").fileURLToPath(urlValue);
    } catch (_e) {
      return "";
    }
  }

  function sourceToText(source: unknown): string | null {
    if (typeof source === "string") return source;
    if (typeof Buffer !== "undefined") {
      if (Buffer.isBuffer(source)) return source.toString("utf8");
      if (source instanceof Uint8Array) return Buffer.from(source).toString("utf8");
      if (source instanceof ArrayBuffer) return Buffer.from(source).toString("utf8");
    }
    return null;
  }

  // Compose with other CommonJS source-rewrite preloads by intercepting
  // Module._compile instead of reading + compiling the file directly. Calling the
  // previous loader lets each wrapper transform the same source in sequence,
  // regardless of NODE_OPTIONS preload order.
  function createComposableJsLoader(originalJsLoader: CommonJsLoader): CommonJsLoader {
    return function nemoclawGooglechatTrustedProxyJsLoader(
      this: unknown,
      mod: CommonJsModuleLike,
      filename: string,
      ...args: unknown[]
    ) {
      if (!isOpenClawGooglechatFile(filename) || typeof mod._compile !== "function") {
        return originalJsLoader.call(this, mod, filename, ...args);
      }

      var originalCompile = mod._compile;
      mod._compile = function nemoclawGooglechatTrustedProxyCompile(
        this: unknown,
        source: unknown,
        loadedFilename?: string,
      ) {
        var sourceText = sourceToText(source);
        var patched =
          sourceText === null
            ? source
            : patchTrustedProxyFetchSource(sourceText, loadedFilename || filename);
        return originalCompile.call(this, patched, loadedFilename);
      };
      try {
        return originalJsLoader.call(this, mod, filename, ...args);
      } finally {
        mod._compile = originalCompile;
      }
    };
  }

  function installTrustedProxyFetchPatch() {
    var Module = require("module");
    var originalJsLoader = Module._extensions && Module._extensions[".js"];
    if (typeof originalJsLoader === "function") {
      Module._extensions[".js"] = createComposableJsLoader(originalJsLoader);
    }

    if (typeof Module.registerHooks === "function") {
      Module.registerHooks({
        load: function nemoclawGooglechatTrustedProxyLoadHook(
          urlValue: string,
          context: unknown,
          nextLoad: NextModuleLoad,
        ) {
          var result = nextLoad(urlValue, context);
          var filename = fileNameFromModuleUrl(urlValue);
          if (!isOpenClawGooglechatFile(filename)) return result;
          var sourceText = sourceToText(result && result.source);
          if (sourceText === null) return result;
          var patched = patchTrustedProxyFetchSource(sourceText, filename);
          if (patched === sourceText) return result;
          return Object.assign({}, result, { source: patched });
        },
      });
    }
  }

  trustedProxyFetchPatchInternals.patchSource = patchTrustedProxyFetchSource;
  trustedProxyFetchPatchInternals.isPatchError = isTrustedProxyFetchPatchError;
  trustedProxyFetchPatchInternals.isOpenClawGooglechatFile = isOpenClawGooglechatFile;
  trustedProxyFetchPatchInternals.createComposableJsLoader = createComposableJsLoader;

  try {
    installTrustedProxyFetchPatch();
    process.stderr.write(
      "[channels] [googlechat] trusted-proxy-fetch patch active " +
        "(googleapis fetches routed via trusted env proxy; no local DNS resolve)\n",
    );
  } catch (e) {
    if (isTrustedProxyFetchPatchError(e)) {
      process.stderr.write(
        "[channels] [googlechat] trusted-proxy-fetch patch NOT applied: " + errorMessage(e) + "\n",
      );
    }
    // Any other failure: never break gateway boot.
  }
})();

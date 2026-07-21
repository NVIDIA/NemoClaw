// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// googlechat-outbound-auth.ts — load-time patch that moves Google Chat OUTBOUND
// authentication off the in-sandbox service-account key and onto a
// gateway-minted token. Boot-injected into the OpenClaw gateway via
// runtime.nodePreloads, gated to when the googlechat channel is active.
//
// ── Workaround Analysis ──────────────────────────────────────────────────────
// 1. What:  rewrites the plugin's single outbound-token producer
//           (getGoogleChatAccessToken) to return the OpenShell placeholder instead
//           of signing a JWT in-process; the proxy swaps it for the real token.
// 2. Why:   stock @openclaw/googlechat mints its token in-process from the SA
//           private key, forcing the key into the sandbox — against the
//           key-out-of-sandbox model. Gateway-side minting keeps the key out.
// 3. Alts:  no native pre-minted-token auth mode upstream yet (5); config injection
//           rejected — the plugin schema is .strict() with no accessToken field.
// 4. Risk:  version-sensitive (bundle anchor) but bounded — integrity-version-pinned
//           plugin, anchors unit-tested; drift AND unset-env both fail loud (throw),
//           so a misconfigured channel never silently sends unauthenticated.
// 5. Exit:  upstream native accessToken/accessTokenRef auth mode — see below.
//
// ── The story: what this changes, and why ────────────────────────────────────
// Out of the box @openclaw/googlechat mints its own OAuth token IN-PROCESS: it
// RS256-signs a JWT assertion with the service-account (SA) PRIVATE KEY and
// exchanges it at oauth2.googleapis.com for an access token. That requires the SA
// private key to live inside the sandbox, which deviates from NemoClaw's security
// model — secrets should never sit in the sandbox; the L7 egress proxy
// materializes them only on outbound requests.
//
// OpenShell can instead mint the Google access token GATEWAY-SIDE from the SA
// key (ProviderCredentialRefreshStrategy google_service_account_jwt) and inject
// it onto outbound chat.googleapis.com requests via the standard credential
// rewrite. In that model the sandbox only ever sees the placeholder
// `openshell:resolve:env:GOOGLE_CHAT_ACCESS_TOKEN`, never the key.
//
// The single producer of the outbound bearer in the plugin is
// `getGoogleChatAccessToken(account)` (auth.ts), funnelled through the one
// request wrapper that stamps `Authorization: Bearer <token>` on every
// chat.googleapis.com call. This preload rewrites that producer at module load
// so it returns the OpenShell-provided credential env value (the placeholder)
// instead of constructing a google-auth client and signing locally. The proxy
// then rewrites the placeholder in the Authorization header to the real minted
// token — the same outbound-placeholder path every other channel uses.
//
// INBOUND webhook JWT verification is untouched: it uses Google's PUBLIC certs
// + appPrincipal (no SA material) and a different code path, so it is unaffected
// by this patch (its cert fetch is handled by the separate
// googlechat-trusted-proxy-fetch patch).
//
// ── Contract with the B-side wiring ──────────────────────────────────────────
// The OpenShell provider's injectable credential key MUST be
// `GOOGLE_CHAT_ACCESS_TOKEN`. When the provider is wired the gateway env carries
// a REVISION-STAMPED placeholder `openshell:resolve:env:vNNN_GOOGLE_CHAT_ACCESS_TOKEN`.
// This patch detects the credential is wired (env set) and returns the REVISION-LESS
// alias `openshell:resolve:env:GOOGLE_CHAT_ACCESS_TOKEN` so the proxy always resolves
// to the LATEST refreshed token — the revision-stamped form pins to the boot token,
// which expires (~1h) and is not refreshed in a long-running process. When the env is
// UNSET (the bridge provider was not wired) the patch THROWS, so a misconfigured
// active channel fails loudly at send time instead of silently.
//
// ── Long-term fix (remove this once it lands) ─────────────────────────────────
// The clean fix is upstream in OpenClaw: a native pre-minted-token auth mode
// (e.g. `accessToken`/`accessTokenRef`) on @openclaw/googlechat that skips
// in-process minting and sends the bearer directly. When that ships, drop this
// preload module and its `runtime.openclaw.nodePreloads` entry in the manifest.
//
// Mechanism mirrors slack-channel-guard.ts (load-time source rewrite of an
// @openclaw/* dist module via the module loader hooks).

// Test seam: the self-installing IIFE below publishes its pure source-rewrite
// helpers here so unit tests can exercise patch / shape-drift / short-circuit
// behavior directly. Requiring this module still installs the loader hooks, but
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

type OutboundAuthPatchInternals = {
  patchSource: (source: string, filename: string) => string;
  buildShortCircuit: () => string;
  isPatchError: (reason: unknown) => boolean;
  isOpenClawGooglechatFile: (filename: unknown) => boolean;
  createComposableJsLoader: (loader: CommonJsLoader) => CommonJsLoader;
};

export const outboundAuthPatchInternals = {} as OutboundAuthPatchInternals;

(function () {
  "use strict";

  // The injectable OpenShell credential key (and sandbox env var) that carries
  // the outbound bearer placeholder. Co-designed with the B-side provider:
  // `provider refresh configure --credential-key GOOGLE_CHAT_ACCESS_TOKEN`.
  var ENV_VAR = "GOOGLE_CHAT_ACCESS_TOKEN";

  // Idempotency / shape markers.
  var CALL_MARKER = "nemoclaw: googlechat outbound bearer via gateway-minted credential";
  var DEF_SIGNATURE = "function getGoogleChatAccessToken";

  var processWithPatchMarker = process as NodeJS.Process & {
    __nemoclawGooglechatOutboundAuthInstalled?: boolean;
  };
  if (processWithPatchMarker.__nemoclawGooglechatOutboundAuthInstalled) return;
  try {
    Object.defineProperty(processWithPatchMarker, "__nemoclawGooglechatOutboundAuthInstalled", {
      value: true,
    });
  } catch (_e) {
    processWithPatchMarker.__nemoclawGooglechatOutboundAuthInstalled = true;
  }

  function isOpenClawGooglechatFile(filename: unknown): boolean {
    var normalized = String(filename || "").replace(/\\/g, "/");
    if (!normalized.endsWith(".js")) return false;
    // The plugin loads either from a package path (/@openclaw/googlechat/) or, when
    // installed as an external extension (openclaw plugins install), flat from
    // ~/.openclaw/extensions/googlechat/dist/. Match both; the getGoogleChatAccessToken
    // shape gate below still confines the rewrite to the auth chunk.
    return (
      normalized.indexOf("/@openclaw/googlechat/") !== -1 ||
      normalized.indexOf("/extensions/googlechat/") !== -1
    );
  }

  // The guard injected at the top of getGoogleChatAccessToken's body. When the
  // OpenShell-provided credential is present (the env var is set), return the
  // REVISION-LESS placeholder `openshell:resolve:env:<KEY>` — NOT the env var's
  // own value. The sandbox env holds a *revision-stamped* placeholder
  // (`openshell:resolve:env:vNNN_<KEY>`) that the proxy pins to the BOOT token;
  // that token expires (~1h, Google SA tokens) and is NOT refreshed inside a
  // long-running gateway process, so returning it directly makes outbound replies
  // die after the first token lifetime ("credential is expired"). The revision-less
  // alias always resolves to the LATEST refreshed token (gateway re-mints on
  // schedule); a raw (non-placeholder) env value is returned as-is for manual
  // non-OpenShell deployments. When the env is UNSET the guard THROWS (the outbound
  // bearer must come from the gateway credential). Built as a single line (no
  // template-literal escaping) for a clean source rewrite.
  function buildBearerShortCircuitSource(): string {
    var canonical = "openshell:resolve:env:" + ENV_VAR;
    return (
      'var __nemoGcRaw = (typeof process !== "undefined" && process.env) ' +
      "? process.env." +
      ENV_VAR +
      ' : void 0; if (typeof __nemoGcRaw === "string" && __nemoGcRaw.length > 0) { ' +
      'return __nemoGcRaw.indexOf("openshell:resolve:env:") === 0 ? "' +
      canonical +
      '" : __nemoGcRaw; } throw new Error("nemoclaw googlechat: ' +
      ENV_VAR +
      ' is not set; the gateway-minted outbound bearer is unavailable"); /* ' +
      CALL_MARKER +
      " */"
    );
  }

  function patchGooglechatOutboundAuthSource(source: string, filename: string): string {
    // Only the dist chunk that DEFINES the producer is a patch target; files that
    // merely call/import it (substring without the `function` keyword) pass through.
    if (source.indexOf(DEF_SIGNATURE) === -1) return source;
    // Already patched (idempotent across repeated --require of this preload).
    if (source.indexOf(CALL_MARKER) !== -1) return source;

    var anchor = /((?:async\s+)?function getGoogleChatAccessToken\s*\(([^)]*)\)\s*\{)/;
    if (!anchor.test(source)) {
      // The definition substring is present but not in the expected shape — the
      // bundled plugin drifted. Fail loud (named patch error) rather than silently
      // leaving outbound auth unpatched.
      throw new Error(
        "OpenClaw Google Chat getGoogleChatAccessToken definition shape not recognized in " +
          filename +
          "; outbound-auth patch not applied",
      );
    }
    return source.replace(anchor, "$1\n  " + buildBearerShortCircuitSource());
  }

  function errorMessage(reason: unknown): string {
    if (typeof reason === "object" && reason !== null && "message" in reason) {
      return String(Reflect.get(reason, "message") ?? "");
    }
    return String(reason ?? "");
  }

  function isGooglechatOutboundAuthPatchError(reason: unknown): boolean {
    var msg = errorMessage(reason);
    return (
      msg.indexOf("OpenClaw Google Chat getGoogleChatAccessToken") !== -1 &&
      msg.indexOf("shape not recognized") !== -1
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
    return function nemoclawGooglechatJsLoader(
      this: unknown,
      mod: CommonJsModuleLike,
      filename: string,
      ...args: unknown[]
    ) {
      if (!isOpenClawGooglechatFile(filename) || typeof mod._compile !== "function") {
        return originalJsLoader.call(this, mod, filename, ...args);
      }

      var originalCompile = mod._compile;
      mod._compile = function nemoclawGooglechatCompile(
        this: unknown,
        source: unknown,
        loadedFilename?: string,
      ) {
        var sourceText = sourceToText(source);
        var patched =
          sourceText === null
            ? source
            : patchGooglechatOutboundAuthSource(sourceText, loadedFilename || filename);
        return originalCompile.call(this, patched, loadedFilename);
      };
      try {
        return originalJsLoader.call(this, mod, filename, ...args);
      } finally {
        mod._compile = originalCompile;
      }
    };
  }

  function installGooglechatOutboundAuthPatch() {
    var Module = require("module");
    var originalJsLoader = Module._extensions && Module._extensions[".js"];
    if (typeof originalJsLoader === "function") {
      Module._extensions[".js"] = createComposableJsLoader(originalJsLoader);
    }

    if (typeof Module.registerHooks === "function") {
      Module.registerHooks({
        load: function nemoclawGooglechatLoadHook(
          urlValue: string,
          context: unknown,
          nextLoad: NextModuleLoad,
        ) {
          var result = nextLoad(urlValue, context);
          var filename = fileNameFromModuleUrl(urlValue);
          if (!isOpenClawGooglechatFile(filename)) return result;
          var sourceText = sourceToText(result && result.source);
          if (sourceText === null) return result;
          var patched = patchGooglechatOutboundAuthSource(sourceText, filename);
          if (patched === sourceText) return result;
          return Object.assign({}, result, { source: patched });
        },
      });
    }
  }

  outboundAuthPatchInternals.patchSource = patchGooglechatOutboundAuthSource;
  outboundAuthPatchInternals.buildShortCircuit = buildBearerShortCircuitSource;
  outboundAuthPatchInternals.isPatchError = isGooglechatOutboundAuthPatchError;
  outboundAuthPatchInternals.isOpenClawGooglechatFile = isOpenClawGooglechatFile;
  outboundAuthPatchInternals.createComposableJsLoader = createComposableJsLoader;

  try {
    installGooglechatOutboundAuthPatch();
    process.stderr.write(
      "[channels] [googlechat] outbound-auth patch active " +
        "(gateway-minted bearer via " +
        ENV_VAR +
        ")\n",
    );
  } catch (e) {
    if (isGooglechatOutboundAuthPatchError(e)) {
      // Shape drift: surface loudly but do not crash gateway startup. With the
      // patch not applied the plugin's outbound auth runs unmodified and cannot use
      // the gateway credential, so the channel breaks loudly on send rather than
      // degrading silently. Boot/health-time fail-closed on drift is a tracked
      // follow-up.
      process.stderr.write(
        "[channels] [googlechat] outbound-auth patch NOT applied: " + errorMessage(e) + "\n",
      );
    }
    // Any other failure: never break gateway boot.
  }
})();

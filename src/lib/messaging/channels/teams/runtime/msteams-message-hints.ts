// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// msteams-message-hints.ts - patch @openclaw/msteams at load time so Teams
// native mention syntax is present in the always-injected message tool hints.
//
// OpenClaw skills are advisory: the model may not load a channel skill before
// sending through the message tool. This preload keeps the channel-critical
// mention format next to the Teams message tool prompt surface without
// modifying the upstream OpenClaw package. Scope this compatibility patch to
// the @openclaw/msteams package only; the upstream send path already parses
// `@[Display Name](Teams user id or AAD object id)` into Teams mention entities.
//
// Removal criterion: drop this preload and its Teams manifest wiring once the
// minimum @openclaw/msteams version installed by NemoClaw includes an equivalent
// native mention hint in agentPrompt.messageToolHints.
//
// The manifest deliberately requires the compiled preload asset (`optional:
// false`) so a missing or mispackaged file fails during sandbox setup. Runtime
// patching is deliberately best-effort: an unexpected upstream export shape or
// immutable plugin must not stop the Teams gateway. In that case, restore the
// loader hook, emit one bounded warning without upstream error data, and keep
// the unmodified upstream plugin running.

type MSTeamsMessageHintsProcess = NodeJS.Process & {
  __nemoclawMSTeamsMessageHintsInstalled?: boolean;
};
type MSTeamsMessageToolHints = (this: unknown, ...args: unknown[]) => unknown;
type MSTeamsAgentPrompt = Record<string, unknown> & {
  messageToolHints?: MSTeamsMessageToolHints;
};
type MSTeamsPlugin = Record<string, unknown> & {
  __nemoclawMSTeamsMessageHintsPatched?: boolean;
  agentPrompt?: unknown;
};
type MSTeamsModuleLoadParent = {
  filename?: unknown;
};
type MSTeamsModuleLoad = (
  this: unknown,
  request: string,
  parent?: MSTeamsModuleLoadParent,
  isMain?: boolean,
) => unknown;
type MSTeamsModuleLike = {
  _load: MSTeamsModuleLoad;
};

(function () {
  "use strict";

  var PATCH_MARKER = "MSTeams mentions: use `@[Display Name]";
  var TARGETING_MARKER = "MSTeams targeting:";
  var MSTEAMS_MENTION_HINT =
    "- MSTeams mentions: use `@[Display Name](Teams user id or AAD object id)` in `message`; plain `@name` text is not a native mention and will not notify.";

  function basename(value: unknown): string {
    return (
      String(value || "")
        .split(/[\\/]/)
        .pop() || ""
    );
  }

  function gatewayProcessFlavor(): string {
    if (basename(process.argv0) === "openclaw-gateway") return "openclaw-gateway";
    if (basename(process.title) === "openclaw-gateway") return "openclaw-gateway";
    if (basename(process.argv[1]) === "openclaw.mjs" && process.argv[2] === "gateway") {
      return "launcher";
    }
    if (basename(process.argv[1]) === "openclaw-gateway") return "openclaw-gateway";
    if (basename(process.argv[0]) === "openclaw-gateway") return "openclaw-gateway";
    return "";
  }

  if (!gatewayProcessFlavor()) return;

  var hintsProcess = process as MSTeamsMessageHintsProcess;
  if (hintsProcess.__nemoclawMSTeamsMessageHintsInstalled) return;
  try {
    Object.defineProperty(hintsProcess, "__nemoclawMSTeamsMessageHintsInstalled", {
      value: true,
    });
  } catch (_e) {
    hintsProcess.__nemoclawMSTeamsMessageHintsInstalled = true;
  }

  function isObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && (typeof value === "object" || typeof value === "function");
  }

  function normalizePathLike(value: unknown): string {
    return String(value || "").replace(/\\/g, "/");
  }

  function isOpenClawMSTeamsPackagePath(value: string): boolean {
    var needle = "/node_modules/@openclaw/msteams/";
    return value.indexOf(needle) !== -1 || value.endsWith("/node_modules/@openclaw/msteams");
  }

  function isOpenClawMSTeamsPluginEntryLoad(
    request: string,
    parent?: MSTeamsModuleLoadParent,
  ): boolean {
    var normalizedRequest = normalizePathLike(request);
    if (normalizedRequest === "@openclaw/msteams/dist/channel-plugin-api.js") return true;
    if (normalizedRequest.endsWith("/node_modules/@openclaw/msteams/dist/channel-plugin-api.js")) {
      return true;
    }
    var parentFile = normalizePathLike(parent && parent.filename);
    return (
      normalizedRequest === "./channel-plugin-api.js" && isOpenClawMSTeamsPackagePath(parentFile)
    );
  }

  function hasMentionHint(hints: readonly unknown[]): boolean {
    return hints.some(function (hint) {
      return String(hint).indexOf(PATCH_MARKER) !== -1;
    });
  }

  function withMentionHint(hints: unknown): unknown {
    if (!Array.isArray(hints) || hasMentionHint(hints)) return hints;
    var next = hints.slice();
    var targetingIndex = next.findIndex(function (hint) {
      return String(hint).indexOf(TARGETING_MARKER) !== -1;
    });
    next.splice(targetingIndex >= 0 ? targetingIndex : next.length, 0, MSTEAMS_MENTION_HINT);
    return next;
  }

  function asAgentPrompt(value: unknown): MSTeamsAgentPrompt | null {
    return isObject(value) ? (value as MSTeamsAgentPrompt) : null;
  }

  function asPlugin(value: unknown): MSTeamsPlugin | null {
    return isObject(value) ? (value as MSTeamsPlugin) : null;
  }

  function patchPlugin(value: unknown): boolean {
    var plugin = asPlugin(value);
    if (!plugin) return false;
    if (plugin.__nemoclawMSTeamsMessageHintsPatched) return true;
    var agentPrompt = asAgentPrompt(plugin.agentPrompt);
    if (!agentPrompt) return false;
    var original = agentPrompt.messageToolHints;
    if (typeof original !== "function") return false;
    var originalMessageToolHints: MSTeamsMessageToolHints = original;

    var patchedPrompt = Object.assign({}, agentPrompt, {
      messageToolHints: function nemoclawMSTeamsMessageToolHints(
        this: unknown,
        ...args: unknown[]
      ): unknown {
        return withMentionHint(originalMessageToolHints.apply(this, args) || []);
      },
    });

    try {
      plugin.agentPrompt = patchedPrompt;
      Object.defineProperty(plugin, "__nemoclawMSTeamsMessageHintsPatched", { value: true });
      return true;
    } catch (_e) {
      // If the plugin object is unexpectedly immutable, fail open so Teams can
      // still start; the hint patch is compatibility guidance, not auth logic.
      return false;
    }
  }

  function patchLoadedModule(loaded: unknown): boolean {
    if (!isObject(loaded)) return false;
    var handled = patchPlugin(loaded.msteamsPlugin);
    var defaultExport = loaded.default;
    handled =
      patchPlugin(isObject(defaultExport) ? defaultExport.msteamsPlugin : undefined) || handled;
    handled = patchPlugin(defaultExport) || handled;
    handled = patchPlugin(loaded) || handled;
    return handled;
  }

  var Module = require("module") as MSTeamsModuleLike;
  var originalLoad = Module._load;
  var warningEmitted = false;
  function warnPatchSkipped(): void {
    if (warningEmitted) return;
    warningEmitted = true;
    var message =
      "NemoClaw could not install the Microsoft Teams mention hint; Teams will continue without the additional prompt guidance.";
    try {
      process.emitWarning(message, { code: "NEMOCLAW_MSTEAMS_HINT_PATCH_SKIPPED" });
    } catch (_e) {
      console.warn(message);
    }
  }
  function restoreLoadHook(): void {
    if (Module._load === nemoclawMSTeamsLoad) {
      Module._load = originalLoad;
    }
  }
  function nemoclawMSTeamsLoad(
    this: unknown,
    request: string,
    parent?: MSTeamsModuleLoadParent,
    isMain?: boolean,
  ): unknown {
    if (!isOpenClawMSTeamsPluginEntryLoad(request, parent)) {
      return originalLoad.call(this, request, parent, isMain);
    }
    try {
      var loaded = originalLoad.call(this, request, parent, isMain);
      try {
        if (!patchLoadedModule(loaded)) warnPatchSkipped();
      } catch (_e) {
        warnPatchSkipped();
      }
      return loaded;
    } finally {
      restoreLoadHook();
    }
  }
  Module._load = nemoclawMSTeamsLoad;
})();

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

  function isOpenClawMSTeamsSpecifier(value: string): boolean {
    return value === "@openclaw/msteams" || value.indexOf("@openclaw/msteams/") === 0;
  }

  function isOpenClawMSTeamsPackagePath(value: string): boolean {
    var needle = "/node_modules/@openclaw/msteams/";
    return value.indexOf(needle) !== -1 || value.endsWith("/node_modules/@openclaw/msteams");
  }

  function isOpenClawMSTeamsLoad(request: string, parent?: MSTeamsModuleLoadParent): boolean {
    var normalizedRequest = normalizePathLike(request);
    if (isOpenClawMSTeamsSpecifier(normalizedRequest)) return true;
    if (isOpenClawMSTeamsPackagePath(normalizedRequest)) return true;
    var parentFile = normalizePathLike(parent && parent.filename);
    return isOpenClawMSTeamsPackagePath(parentFile);
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

  function patchPlugin(value: unknown): void {
    var plugin = asPlugin(value);
    if (!plugin || plugin.__nemoclawMSTeamsMessageHintsPatched) return;
    var agentPrompt = asAgentPrompt(plugin.agentPrompt);
    if (!agentPrompt) return;
    var original = agentPrompt.messageToolHints;
    if (typeof original !== "function") return;
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
    } catch (_e) {
      // If the plugin object is unexpectedly immutable, fail open so Teams can
      // still start; the hint patch is compatibility guidance, not auth logic.
    }
  }

  function patchLoadedModule(loaded: unknown): unknown {
    if (!isObject(loaded)) return loaded;
    patchPlugin(loaded.msteamsPlugin);
    var defaultExport = loaded.default;
    patchPlugin(isObject(defaultExport) ? defaultExport.msteamsPlugin : undefined);
    patchPlugin(defaultExport);
    patchPlugin(loaded);
    return loaded;
  }

  var Module = require("module") as MSTeamsModuleLike;
  var originalLoad = Module._load;
  Module._load = function nemoclawMSTeamsLoad(
    this: unknown,
    request: string,
    parent?: MSTeamsModuleLoadParent,
    isMain?: boolean,
  ): unknown {
    var loaded = originalLoad.call(this, request, parent, isMain);
    if (isOpenClawMSTeamsLoad(request, parent)) {
      return patchLoadedModule(loaded);
    }
    return loaded;
  };
})();

// @ts-nocheck
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

(function () {
  "use strict";

  var PATCH_MARKER = "MSTeams mentions: use `@[Display Name]";
  var TARGETING_MARKER = "MSTeams targeting:";
  var MSTEAMS_MENTION_HINT =
    "- MSTeams mentions: use `@[Display Name](Teams user id or AAD object id)` in `message`; plain `@name` text is not a native mention and will not notify.";

  if (process.__nemoclawMSTeamsMessageHintsInstalled) return;
  try {
    Object.defineProperty(process, "__nemoclawMSTeamsMessageHintsInstalled", { value: true });
  } catch (_e) {
    process.__nemoclawMSTeamsMessageHintsInstalled = true;
  }

  function isObject(value) {
    return Boolean(value) && (typeof value === "object" || typeof value === "function");
  }

  function normalizePathLike(value) {
    return String(value || "").replace(/\\/g, "/");
  }

  function isOpenClawMSTeamsSpecifier(value) {
    return value === "@openclaw/msteams" || value.indexOf("@openclaw/msteams/") === 0;
  }

  function isOpenClawMSTeamsPackagePath(value) {
    var needle = "/node_modules/@openclaw/msteams/";
    return value.indexOf(needle) !== -1 || value.endsWith("/node_modules/@openclaw/msteams");
  }

  function isOpenClawMSTeamsLoad(request, parent) {
    var normalizedRequest = normalizePathLike(request);
    if (isOpenClawMSTeamsSpecifier(normalizedRequest)) return true;
    if (isOpenClawMSTeamsPackagePath(normalizedRequest)) return true;
    var parentFile = normalizePathLike(parent && parent.filename);
    return isOpenClawMSTeamsPackagePath(parentFile);
  }

  function hasMentionHint(hints) {
    return hints.some(function (hint) {
      return String(hint).indexOf(PATCH_MARKER) !== -1;
    });
  }

  function withMentionHint(hints) {
    if (!Array.isArray(hints) || hasMentionHint(hints)) return hints;
    var next = hints.slice();
    var targetingIndex = next.findIndex(function (hint) {
      return String(hint).indexOf(TARGETING_MARKER) !== -1;
    });
    next.splice(targetingIndex >= 0 ? targetingIndex : next.length, 0, MSTEAMS_MENTION_HINT);
    return next;
  }

  function patchPlugin(plugin) {
    if (!isObject(plugin) || plugin.__nemoclawMSTeamsMessageHintsPatched) return;
    var agentPrompt = plugin.agentPrompt;
    var original = agentPrompt && agentPrompt.messageToolHints;
    if (typeof original !== "function") return;

    var patchedPrompt = Object.assign({}, agentPrompt, {
      messageToolHints: function nemoclawMSTeamsMessageToolHints() {
        return withMentionHint(original.apply(this, arguments) || []);
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

  function patchLoadedModule(loaded) {
    if (!isObject(loaded)) return loaded;
    patchPlugin(loaded.msteamsPlugin);
    patchPlugin(loaded.default && loaded.default.msteamsPlugin);
    patchPlugin(loaded.default);
    patchPlugin(loaded);
    return loaded;
  }

  var Module = require("module");
  var originalLoad = Module._load;
  Module._load = function nemoclawMSTeamsLoad(request, parent, isMain) {
    var loaded = originalLoad.apply(this, arguments);
    if (isOpenClawMSTeamsLoad(request, parent)) {
      return patchLoadedModule(loaded);
    }
    return loaded;
  };
})();

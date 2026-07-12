// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// slack-channel-guard.ts — catches unhandled promise rejections from Slack
// channel initialization so a single channel auth failure does not crash
// the entire OpenClaw gateway. Node v22 treats unhandled rejections as
// fatal (--unhandled-rejections=throw is the default), taking down
// inference, chat, and TUI alongside the failed Slack channel.
//
// This preload wraps process.emit for Slack-specific process-level failures
// and consumes those events before later OpenClaw handlers can treat the
// provider startup failure as fatal. Non-Slack failures pass through to the
// original event machinery unchanged.
//
// It also patches @openclaw/slack at module-load time so a denied explicit
// @-mention still blocks the command but sends one bounded sender-facing
// feedback message. Keeping this in the Slack runtime preload lets the channel
// manifest own the behavior through runtime.nodePreloads instead of Dockerfile
// channel-specific patch commands.
//
// Ref: https://github.com/NVIDIA/NemoClaw/issues/2340
// Ref: https://github.com/NVIDIA/NemoClaw/issues/4752

(function () {
  "use strict";

  var HELPER_MARKER = "__nemoclawNotifyDeniedSlackMention";
  var CALL_MARKER = "nemoclaw: bounded denial feedback for explicit slack @-mentions";
  var DENY_LOG_SIGNATURE = "Blocked unauthorized slack sender";

  // Slack-specific error codes from @slack/web-api that indicate auth failure.
  // These appear as error.code on the WebAPIRequestError or CodedError objects.
  var SLACK_AUTH_ERRORS = [
    "slack_webapi_platform_error",
    "slack_webapi_request_error",
    "slackbot_error",
  ];

  // Slack-specific error messages that indicate auth/token problems.
  var SLACK_AUTH_MESSAGES = [
    "invalid_auth",
    "not_authed",
    "token_revoked",
    "token_expired",
    "account_inactive",
    "missing_scope",
    "not_allowed_token_type",
    "An API error occurred: invalid_auth",
  ];

  function mentionsSlackHost(value) {
    var tokens = String(value || "").split(/\s+/);
    for (var i = 0; i < tokens.length; i++) {
      var candidate = tokens[i].replace(/^[<("']+|[>),."']+$/g, "");
      try {
        var parsed = new URL(candidate);
        var host = parsed.hostname.toLowerCase();
        if (host === "slack.com" || host.endsWith(".slack.com")) return true;
      } catch (_e) {
        if (/^(?:[a-z0-9-]+\.)*slack\.com(?::\d+)?$/i.test(candidate)) return true;
      }
    }
    return false;
  }

  function isSlackRejection(reason) {
    if (!reason) return false;
    if (isSlackDenyFeedbackPatchError(reason)) return false;

    // Check error code (Slack SDK sets .code on its errors)
    var code = reason.code || "";
    for (var i = 0; i < SLACK_AUTH_ERRORS.length; i++) {
      if (code === SLACK_AUTH_ERRORS[i]) return true;
    }

    // Check error message
    var msg = String(reason.message || reason);
    for (var j = 0; j < SLACK_AUTH_MESSAGES.length; j++) {
      if (msg.indexOf(SLACK_AUTH_MESSAGES[j]) !== -1) return true;
    }

    // Check stack trace for @slack/ packages
    var stack = reason.stack || "";
    if (stack.indexOf("@slack/") !== -1 || stack.indexOf("slack-") !== -1) {
      return true;
    }

    // Check for proxy/network errors targeting Slack domains.
    // When the network policy blocks or rejects connections to Slack
    // servers, the error comes from the HTTP client (CONNECT tunnel
    // failure), not from @slack/ code. The stack won't contain @slack/
    // but the error message or URL may reference the Slack hostname.
    if (mentionsSlackHost(msg)) {
      return true;
    }

    return false;
  }

  function isSlackDenyFeedbackPatchError(reason) {
    var msg = String((reason && reason.message) || reason || "");
    return (
      msg.indexOf("OpenClaw Slack ") !== -1 &&
      (msg.indexOf("shape not recognized") !== -1 ||
        msg.indexOf("prepareSlackMessage definition not found") !== -1)
    );
  }

  function handleSlackError(reason, source) {
    if (isSlackRejection(reason)) {
      var msg = reason && reason.message ? reason.message : String(reason);
      process.stderr.write(
        "[channels] [slack] provider failed to start: " +
          msg +
          " \u2014 " +
          source +
          " caught by safety net, gateway continues\n",
      );
      return true; // handled
    }
    return false;
  }

  if (process.__nemoclawSlackChannelGuardInstalled) return;
  try {
    Object.defineProperty(process, "__nemoclawSlackChannelGuardInstalled", { value: true });
  } catch (_e) {
    process.__nemoclawSlackChannelGuardInstalled = true;
  }

  function buildDeniedMentionFeedbackHelperSource() {
    return [
      "async function __nemoclawNotifyDeniedSlackMention(params) {",
      "\t// nemoclaw: bounded sender-facing feedback for an explicit @-mention whose",
      "\t// command was denied by the channel allowlist. Keeps the command blocked,",
      "\t// never reveals the allowlist, and emits exactly one sender-facing message",
      "\t// (ephemeral in-channel, DM fallback). (#4752)",
      "\tconst { ctx, message, senderId } = params;",
      "\tif (!params.explicitMention) return;",
      "\tconst client = ctx?.app?.client;",
      "\tconst channel = message?.channel;",
      "\tconst user = senderId ?? message?.user;",
      "\tif (!client?.chat || !channel || !user) return;",
      '\tconst text = "Sorry, you\\\'re not authorized to use this assistant in this channel, so your request was not processed.";',
      "\tconst threadTs = message?.thread_ts ?? message?.ts;",
      "\ttry {",
      "\t\tawait client.chat.postEphemeral({ channel, user, text, ...threadTs ? { thread_ts: threadTs } : {} });",
      "\t\treturn;",
      "\t} catch (ephemeralError) {",
      "\t\t// Only fall back to a DM when Slack definitively did not deliver the",
      "\t\t// ephemeral. Ambiguous failures (network/HTTP, timeout, service errors)",
      "\t\t// may have been accepted, so a DM there could double-notify the sender.",
      "\t\tconst ephemeralErrorCode = ephemeralError?.data?.error ?? ephemeralError?.code;",
      '\t\tctx?.logger?.warn?.({ err: ephemeralError, channel, code: ephemeralErrorCode }, "nemoclaw: slack denial ephemeral feedback failed (#4752)");',
      '\t\tconst nonDeliveryCodes = ["user_not_in_channel", "not_in_channel", "channel_not_found", "cannot_reply_to_message", "is_archived", "messages_tab_disabled"];',
      "\t\tif (!nonDeliveryCodes.includes(ephemeralErrorCode)) return;",
      "\t\ttry {",
      "\t\t\tconst opened = await client.conversations?.open?.({ users: user });",
      "\t\t\tconst dmChannel = opened?.channel?.id;",
      "\t\t\tif (dmChannel) await client.chat.postMessage({ channel: dmChannel, text });",
      "\t\t} catch (dmError) {",
      '\t\t\tctx?.logger?.warn?.({ err: dmError }, "nemoclaw: slack denial DM feedback failed (#4752)");',
      "\t\t}",
      "\t}",
      "}",
      "",
    ].join("\n");
  }

  function isOpenClawSlackFile(filename) {
    var normalized = String(filename || "").replace(/\\/g, "/");
    return normalized.indexOf("/@openclaw/slack/") !== -1 && normalized.endsWith(".js");
  }

  function patchSlackPrepareSource(source, filename) {
    if (source.indexOf("async function prepareSlackMessage") === -1) return source;
    if (
      source.indexOf("async function " + HELPER_MARKER + "(") !== -1 &&
      source.indexOf(CALL_MARKER) !== -1
    ) {
      return source;
    }
    if (source.indexOf(DENY_LOG_SIGNATURE) === -1) {
      throw new Error(
        "OpenClaw Slack prepare module shape not recognized in " +
          filename +
          "; expected denied-sender log signature",
      );
    }
    if (
      source.indexOf("explicitlyMentionedBotUser") === -1 ||
      source.indexOf("explicitlyMentionedBotSubteam") === -1
    ) {
      throw new Error(
        "OpenClaw Slack mention-state shape not recognized in " +
          filename +
          "; expected explicitlyMentionedBotUser/explicitlyMentionedBotSubteam in the prepare deny path",
      );
    }

    var next = source;
    if (next.indexOf(CALL_MARKER) === -1) {
      next = next.replace(
        /(logVerbose\(`Blocked unauthorized slack sender \$\{senderId\} \(not in channel users\)`\);\n)(\s*)return null;/,
        function (_match, logLine, indent) {
          return (
            logLine +
            indent +
            "await __nemoclawNotifyDeniedSlackMention({ ctx, message, senderId, " +
            'explicitMention: opts.source === "app_mention" || explicitlyMentionedBotUser || explicitlyMentionedBotSubteam }); ' +
            "// " +
            CALL_MARKER +
            " (#4752)\n" +
            indent +
            "return null;"
          );
        },
      );
      if (next === source) {
        throw new Error(
          "OpenClaw Slack channel-users deny gate shape not recognized in " + filename,
        );
      }
    }

    if (next.indexOf("async function " + HELPER_MARKER + "(") === -1) {
      var prepareAnchor = /((?:export\s+)?async function prepareSlackMessage\(params\) \{)/;
      if (!prepareAnchor.test(next)) {
        throw new Error("OpenClaw Slack prepareSlackMessage definition not found in " + filename);
      }
      next = next.replace(prepareAnchor, buildDeniedMentionFeedbackHelperSource() + "$1");
    }
    return next;
  }

  function fileNameFromModuleUrl(urlValue) {
    if (typeof urlValue !== "string" || !urlValue.startsWith("file:")) return "";
    try {
      return require("url").fileURLToPath(urlValue);
    } catch (_e) {
      return "";
    }
  }

  function sourceToText(source) {
    if (typeof source === "string") return source;
    if (typeof Buffer !== "undefined") {
      if (Buffer.isBuffer(source)) return source.toString("utf8");
      if (source instanceof Uint8Array) return Buffer.from(source).toString("utf8");
      if (source instanceof ArrayBuffer) return Buffer.from(source).toString("utf8");
    }
    return null;
  }

  function installSlackDenyFeedbackPatch() {
    var Module = require("module");
    var fs = require("fs");
    var originalJsLoader = Module._extensions && Module._extensions[".js"];
    if (typeof originalJsLoader === "function") {
      Module._extensions[".js"] = function nemoclawSlackJsLoader(mod, filename) {
        if (isOpenClawSlackFile(filename)) {
          var source = fs.readFileSync(filename, "utf8");
          var patched = patchSlackPrepareSource(source, filename);
          if (patched !== source) {
            return mod._compile(patched, filename);
          }
        }
        return originalJsLoader.apply(this, arguments);
      };
    }

    if (typeof Module.registerHooks === "function") {
      Module.registerHooks({
        load: function nemoclawSlackLoadHook(urlValue, context, nextLoad) {
          var result = nextLoad(urlValue, context);
          var filename = fileNameFromModuleUrl(urlValue);
          if (!isOpenClawSlackFile(filename)) return result;
          var sourceText = sourceToText(result && result.source);
          if (sourceText === null) return result;
          var patched = patchSlackPrepareSource(sourceText, filename);
          if (patched === sourceText) return result;
          return Object.assign({}, result, { source: patched });
        },
      });
    }
  }

  installSlackDenyFeedbackPatch();

  var origEmit = process.emit;
  process.emit = function (eventName) {
    if (eventName === "unhandledRejection") {
      if (handleSlackError(arguments[1], "unhandledRejection")) return true;
    } else if (eventName === "uncaughtException") {
      if (handleSlackError(arguments[1], "uncaughtException")) return true;
    }
    return origEmit.apply(this, arguments);
  };
})();

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// telegram-diagnostics.ts — adds runtime breadcrumbs for OpenClaw's Telegram
// channel without changing channel behavior. The important distinction for
// NemoClaw#2766 is that "[telegram] [default] starting provider" means the
// channel is initializing; an agent-turn failure later can be an inference
// provider failure through inference.local, not a Telegram Bot API failure.

type TelegramDiagnosticsProcess = NodeJS.Process & {
  __nemoclawTelegramDiagnosticsInstalled?: boolean;
};
type TelegramJsonObject = Record<string, unknown>;
type TelegramRequestInfo = { hostname: string; path: string };
type TelegramStderrWrite = (...args: unknown[]) => boolean;
type TelegramHttpModuleLike = Record<string, unknown>;
type TelegramRequestLike = {
  once(eventName: string, listener: (...args: unknown[]) => void): unknown;
};
type TelegramResponseLike = {
  on(eventName: string, listener: (...args: unknown[]) => void): unknown;
  statusCode?: unknown;
};
type TelegramHttpRequestLike = (
  this: unknown,
  ...args: unknown[]
) => TelegramRequestLike | undefined;

(function () {
  "use strict";

  var diagnosticsProcess = process as TelegramDiagnosticsProcess;
  if (diagnosticsProcess.__nemoclawTelegramDiagnosticsInstalled) return;
  try {
    Object.defineProperty(diagnosticsProcess, "__nemoclawTelegramDiagnosticsInstalled", {
      value: true,
    });
  } catch (_e) {
    diagnosticsProcess.__nemoclawTelegramDiagnosticsInstalled = true;
  }

  var providerStarted = false;
  var readyLogged = false;
  var startupProbeLogged = false;
  var inferenceLogged = false;
  var credentialLogged = false;
  var runtimeConfigLogged = false;
  var sendMessageLogged = false;
  var inboundUpdateLogged = false;
  var inDiagnosticWrite = false;

  function asObject(value: unknown): TelegramJsonObject | null {
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as TelegramJsonObject)
      : null;
  }

  function sanitize(value: unknown): string {
    var text = String(value || "");
    text = text.replace(/\/bot[^/\s"']+/g, "/bot<redacted>");
    text = text.replace(/\/file\/bot[^/\s"']+/g, "/file/bot<redacted>");
    text = text.replace(/Bearer\s+[A-Za-z0-9._~+\/=-]+/g, "Bearer <redacted>");
    text = text.replace(
      /\b(api[_-]?key|token|authorization)\b(["']?\s*[:=]\s*["']?)[^"'\s,)]+/gi,
      "$1$2<redacted>",
    );
    return text;
  }

  var stderr = process.stderr as NodeJS.WriteStream & { write: TelegramStderrWrite };
  var originalStderrWrite = stderr.write.bind(stderr) as TelegramStderrWrite;

  function emit(line: string): void {
    if (inDiagnosticWrite) return;
    inDiagnosticWrite = true;
    try {
      originalStderrWrite(line + "\n");
    } finally {
      inDiagnosticWrite = false;
    }
  }

  function describeRequest(arg1: unknown, arg2: unknown): TelegramRequestInfo {
    var url: URL | null = null;
    var opts: TelegramJsonObject | null = null;
    if (typeof arg1 === "string" || arg1 instanceof URL) {
      try {
        url = new URL(String(arg1));
      } catch (_e) {
        url = null;
      }
      opts = asObject(arg2);
    } else if (arg1 && typeof arg1 === "object") {
      opts = asObject(arg1);
    }

    var hostname = "";
    var path = "";
    if (url) {
      hostname = url.hostname || "";
      path = (url.pathname || "") + (url.search || "");
    }
    if (opts) {
      hostname = String(opts.hostname || opts.host || hostname || "");
      path = String(opts.path || path || "");
    }
    if (hostname.indexOf(":") !== -1) hostname = hostname.split(":")[0];
    return { hostname: hostname, path: path };
  }

  function telegramApiMethod(info: TelegramRequestInfo): string {
    if (info.hostname !== "api.telegram.org") return "";
    var match = /\/(?:bot[^/]+\/)?([^/?]+)(?:\?|$)/.exec(info.path || "");
    return match && match[1] ? match[1] : "";
  }

  function isTelegramStartupProbe(info: TelegramRequestInfo): boolean {
    var method = telegramApiMethod(info);
    return method === "getUpdates" || method === "getMe" || method === "getWebhookInfo";
  }

  function maybeLogTelegramStartupProbe(info: TelegramRequestInfo, statusCode: unknown): void {
    if (!isTelegramStartupProbe(info)) return;
    providerStarted = true;
    var status = Number(statusCode);
    if (status >= 200 && status < 300) {
      if (readyLogged) return;
      readyLogged = true;
      emit(
        "[telegram] [default] provider ready (Bot API reachable; agent replies use inference.local)",
      );
      return;
    }
    if (startupProbeLogged) return;
    startupProbeLogged = true;
    if (status === 401 || status === 404) {
      emit(
        "[telegram] [default] Bot API rejected startup probe with HTTP " +
          status +
          "; token invalid or credential placeholder unresolved",
      );
      return;
    }
    if (status >= 300) {
      emit("[telegram] [default] Bot API startup probe returned HTTP " + status);
    }
  }

  function maybeLogTelegramStartupError(info: TelegramRequestInfo, error: unknown): void {
    if (!isTelegramStartupProbe(info) || startupProbeLogged) return;
    providerStarted = true;
    startupProbeLogged = true;
    var errorObject = asObject(error);
    var detail =
      errorObject && (errorObject.code || errorObject.message)
        ? errorObject.code || errorObject.message
        : error;
    emit("[telegram] [default] Bot API startup probe failed: " + sanitize(detail).slice(0, 300));
  }

  function maybeLogTelegramSendMessage(info: TelegramRequestInfo, statusCode: unknown): void {
    if (sendMessageLogged || telegramApiMethod(info) !== "sendMessage") return;
    sendMessageLogged = true;
    emit(
      "[telegram] [default] outbound sendMessage attempted; Bot API returned HTTP " +
        Number(statusCode || 0),
    );
  }

  function senderAllowlistState(senderId: unknown): string {
    if (senderId === undefined || senderId === null) return "unknown";
    var configPath = process.env.OPENCLAW_CONFIG_PATH || "/sandbox/.openclaw/openclaw.json";
    try {
      var fs = require("fs");
      var account = readTelegramAccount(JSON.parse(fs.readFileSync(configPath, "utf8")));
      if (!account || account.dmPolicy !== "allowlist") return "not-applicable";
      var allowFrom = Array.isArray(account.allowFrom) ? account.allowFrom.map(String) : [];
      return allowFrom.indexOf(String(senderId)) === -1 ? "false" : "true";
    } catch (_e) {
      return "unknown";
    }
  }

  function maybeLogTelegramInboundUpdate(info: TelegramRequestInfo, body: unknown): void {
    if (inboundUpdateLogged || telegramApiMethod(info) !== "getUpdates") return;
    var payload: TelegramJsonObject | null = null;
    try {
      payload = asObject(JSON.parse(String(body || "")));
    } catch (_e) {
      return;
    }
    if (!payload || payload.ok !== true || !Array.isArray(payload.result)) return;
    for (var i = 0; i < payload.result.length; i += 1) {
      var update = asObject(payload.result[i]);
      if (!update) continue;
      var message =
        asObject(update.message) ||
        asObject(update.edited_message) ||
        asObject(update.channel_post) ||
        asObject(update.edited_channel_post);
      if (!message) continue;
      inboundUpdateLogged = true;
      var chat = asObject(message.chat) || {};
      var from = asObject(message.from) || {};
      var chatType =
        typeof chat.type === "string"
          ? sanitize(chat.type)
              .replace(/[^A-Za-z0-9_-]/g, "")
              .slice(0, 40)
          : "unknown";
      var updateIdState =
        update.update_id === undefined || update.update_id === null ? "missing" : "present";
      var messageIdState =
        message.message_id === undefined || message.message_id === null ? "missing" : "present";
      emit(
        "[telegram] [default] inbound update received (update_id=" +
          updateIdState +
          "; message_id=" +
          messageIdState +
          "; chat_type=" +
          chatType +
          "; sender_allowlisted=" +
          senderAllowlistState(from.id) +
          ")",
      );
      return;
    }
  }

  function readTelegramAccount(config: unknown): TelegramJsonObject | null {
    var root = asObject(config);
    if (!root) return null;
    var channels = asObject(root.channels);
    var channel = channels ? asObject(channels.telegram) : null;
    if (!channel) return null;
    var accounts = asObject(channel.accounts);
    if (!accounts) return null;
    var account = asObject(accounts.default) || asObject(accounts.main);
    if (!account) {
      var keys = Object.keys(accounts);
      account = keys.length ? asObject(accounts[keys[0]]) : null;
    }
    return account;
  }

  function readTelegramBotToken(config: unknown): string {
    var account = readTelegramAccount(config);
    return account && typeof account.botToken === "string" ? account.botToken : "";
  }

  function maybeLogRuntimeConfigDiagnostics(): void {
    if (runtimeConfigLogged) return;
    runtimeConfigLogged = true;
    var configPath = process.env.OPENCLAW_CONFIG_PATH || "/sandbox/.openclaw/openclaw.json";
    var account: TelegramJsonObject | null = null;
    try {
      var fs = require("fs");
      account = readTelegramAccount(JSON.parse(fs.readFileSync(configPath, "utf8")));
    } catch (_e) {
      return;
    }
    if (!account) return;
    var allowFrom = Array.isArray(account.allowFrom) ? account.allowFrom : [];
    if (account.dmPolicy === "allowlist") {
      if (allowFrom.length > 0) {
        emit(
          "[telegram] [default] DM allowlist configured (" +
            allowFrom.length +
            " entr" +
            (allowFrom.length === 1 ? "y" : "ies") +
            ")",
        );
      } else {
        emit(
          "[telegram] [default] DM allowlist is empty; set TELEGRAM_ALLOWED_IDS before rebuild or complete OpenClaw pairing before expecting direct-message replies",
        );
      }
    }
  }

  function maybeLogCredentialPlaceholderDiagnostics(): void {
    if (credentialLogged) return;
    credentialLogged = true;
    var prefix = "openshell:resolve:env:";
    var envToken = process.env.TELEGRAM_BOT_TOKEN || "";
    var configPath = process.env.OPENCLAW_CONFIG_PATH || "/sandbox/.openclaw/openclaw.json";
    var configToken = "";
    try {
      var fs = require("fs");
      configToken = readTelegramBotToken(JSON.parse(fs.readFileSync(configPath, "utf8")));
    } catch (_e) {
      return;
    }
    if (!configToken || configToken.indexOf(prefix) !== 0) return;
    if (!envToken) {
      emit(
        "[telegram] [default] credential placeholder configured but TELEGRAM_BOT_TOKEN is missing from runtime env",
      );
      return;
    }
    if (envToken.indexOf(prefix) !== 0) return;
    if (configToken !== envToken) {
      emit(
        "[telegram] [default] credential placeholder mismatch: openclaw.json botToken does not match runtime TELEGRAM_BOT_TOKEN placeholder",
      );
    }
  }

  function wrapHttp(mod: TelegramHttpModuleLike, methodName: string): void {
    var original = mod[methodName] as TelegramHttpRequestLike | undefined;
    if (typeof original !== "function") return;
    var originalRequest: TelegramHttpRequestLike = original;
    mod[methodName] = function (this: unknown, ...args: unknown[]) {
      var info = describeRequest(args[0], args[1]);
      var req = originalRequest.apply(this, args);
      if (info.hostname === "api.telegram.org" && req && typeof req.once === "function") {
        req.once("response", function (res) {
          var response = res as TelegramResponseLike | null;
          maybeLogTelegramStartupProbe(info, response && response.statusCode);
          maybeLogTelegramSendMessage(info, response && response.statusCode);
          if (
            !inboundUpdateLogged &&
            telegramApiMethod(info) === "getUpdates" &&
            response &&
            typeof response.on === "function"
          ) {
            var responseChunks: string[] = [];
            var responseBytes = 0;
            response.on("data", function (chunk) {
              if (responseBytes >= 65536) return;
              var text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk || "");
              responseBytes += Buffer.byteLength(text);
              if (responseBytes <= 65536) responseChunks.push(text);
            });
            response.on("end", function () {
              maybeLogTelegramInboundUpdate(info, responseChunks.join(""));
            });
          }
        });
        req.once("error", function (error) {
          maybeLogTelegramStartupError(info, error);
        });
      }
      return req;
    };
  }

  stderr.write = function (...args: unknown[]): boolean {
    var chunk = args[0];
    var ret = originalStderrWrite(...args);
    if (!inDiagnosticWrite && !inferenceLogged) {
      var text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk || "");
      if (!providerStarted && /\[telegram\] \[default\] starting provider\b/i.test(text)) {
        providerStarted = true;
      }
      if (
        providerStarted &&
        /Embedded agent failed before reply|LLM request failed|FailoverError/i.test(text)
      ) {
        inferenceLogged = true;
        var line =
          text.split(/\r?\n/).find(function (entry: string) {
            return /Embedded agent failed before reply|LLM request failed|FailoverError/i.test(
              entry,
            );
          }) || text;
        emit(
          "[telegram] [default] agent turn failed after provider startup; inference error: " +
            sanitize(line).slice(0, 600),
        );
      }
    }
    return ret;
  };

  var http = require("http");
  var https = require("https");
  wrapHttp(http, "request");
  wrapHttp(http, "get");
  wrapHttp(https, "request");
  wrapHttp(https, "get");
  process.nextTick(maybeLogCredentialPlaceholderDiagnostics);

  // Defense in depth for #4314/#4390: if Telegram is configured but the
  // bridge module never logs "starting provider" and never hits the Bot
  // API within the startup window, surface a single actionable breadcrumb
  // so the channel is observably broken instead of silently invisible.
  //
  // Gate to the OpenClaw gateway process flavors only. The preload is
  // exported via NODE_OPTIONS, so every short-lived Node child the user
  // spawns inside the sandbox (CLI tools, shells, npm scripts) also requires
  // this file; without the gate the timer would emit a false "bridge did
  // not start" line from every Node command even while the real gateway
  // bridge is healthy. Mirrors sandbox-safety-net.js's gatewayProcessFlavor.
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
    if (process.argv[2] === "gateway") return "launcher";
    if (basename(process.argv[1]) === "openclaw-gateway") return "openclaw-gateway";
    if (basename(process.argv[0]) === "openclaw-gateway") return "openclaw-gateway";
    return "";
  }
  if (!gatewayProcessFlavor()) return;
  process.nextTick(maybeLogRuntimeConfigDiagnostics);
  var STARTUP_GRACE_MS = Number(process.env.NEMOCLAW_TELEGRAM_STARTUP_GRACE_MS || "") || 15000;
  var noStartupTimer = setTimeout(function () {
    if (providerStarted || startupProbeLogged) return;
    var configPath = process.env.OPENCLAW_CONFIG_PATH || "/sandbox/.openclaw/openclaw.json";
    try {
      var fs = require("fs");
      var cfg = asObject(JSON.parse(fs.readFileSync(configPath, "utf8")));
      var channels = cfg ? asObject(cfg.channels) : null;
      var telegram = channels ? asObject(channels.telegram) : null;
      if (!telegram || telegram.enabled === false) return;
      var accounts = asObject(telegram.accounts) || {};
      if (!Object.keys(accounts).length) return;
    } catch (_e) {
      return;
    }
    emit(
      "[telegram] [default] bridge did not start within " +
        Math.round(STARTUP_GRACE_MS / 1000) +
        "s; check channels.telegram.enabled, plugin entries, and gateway log",
    );
  }, STARTUP_GRACE_MS);
  if (typeof noStartupTimer.unref === "function") noStartupTimer.unref();
})();

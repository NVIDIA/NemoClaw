// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// slack-channel-guard.js — catches unhandled promise rejections from Slack
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
// Ref: https://github.com/NVIDIA/NemoClaw/issues/2340

(function () {
  'use strict';

  // Slack-specific error codes from @slack/web-api that indicate auth failure.
  // These appear as error.code on the WebAPIRequestError or CodedError objects.
  var SLACK_AUTH_ERRORS = [
    'slack_webapi_platform_error',
    'slack_webapi_request_error',
    'slackbot_error',
  ];

  // Slack-specific error messages that indicate auth/token problems.
  var SLACK_AUTH_MESSAGES = [
    'invalid_auth',
    'not_authed',
    'token_revoked',
    'token_expired',
    'account_inactive',
    'missing_scope',
    'not_allowed_token_type',
    'An API error occurred: invalid_auth',
  ];

  function isSlackRejection(reason) {
    if (!reason) return false;

    // Check error code (Slack SDK sets .code on its errors)
    var code = reason.code || '';
    for (var i = 0; i < SLACK_AUTH_ERRORS.length; i++) {
      if (code === SLACK_AUTH_ERRORS[i]) return true;
    }

    // Check error message
    var msg = String(reason.message || reason);
    for (var j = 0; j < SLACK_AUTH_MESSAGES.length; j++) {
      if (msg.indexOf(SLACK_AUTH_MESSAGES[j]) !== -1) return true;
    }

    // Check stack trace for @slack/ packages
    var stack = reason.stack || '';
    if (stack.indexOf('@slack/') !== -1 || stack.indexOf('slack-') !== -1) {
      return true;
    }

    // Check for proxy/network errors targeting Slack domains.
    // When the network policy blocks or rejects connections to Slack
    // servers, the error comes from the HTTP client (CONNECT tunnel
    // failure), not from @slack/ code. The stack won't contain @slack/
    // but the error message or URL may reference the Slack hostname.
    if (msg.indexOf('slack.com') !== -1) {
      return true;
    }

    return false;
  }

  function handleSlackError(reason, source) {
    if (isSlackRejection(reason)) {
      var msg = (reason && reason.message) ? reason.message : String(reason);
      process.stderr.write(
        '[channels] [slack] provider failed to start: ' + msg +
        ' \u2014 ' + source + ' caught by safety net, gateway continues\n'
      );
      return true; // handled
    }
    return false;
  }

  if (process.__nemoclawSlackChannelGuardInstalled) return;
  try {
    Object.defineProperty(process, '__nemoclawSlackChannelGuardInstalled', { value: true });
  } catch (_e) {
    process.__nemoclawSlackChannelGuardInstalled = true;
  }

  var origEmit = process.emit;
  process.emit = function (eventName) {
    if (eventName === 'unhandledRejection') {
      if (handleSlackError(arguments[1], 'unhandledRejection')) return true;
    } else if (eventName === 'uncaughtException') {
      if (handleSlackError(arguments[1], 'uncaughtException')) return true;
    }
    return origEmit.apply(this, arguments);
  };
})();

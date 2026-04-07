// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Telegram Bot API client with socket timeout protection.
 *
 * Exported so both the bridge script and tests use the same implementation.
 */

const https = require("https");

const DEFAULT_TIMEOUT_MS = 60000;

/**
 * Call a Telegram Bot API method.
 *
 * @param {string} token  - Bot token from BotFather
 * @param {string} method - API method name (e.g. "getUpdates")
 * @param {object} body   - JSON-serialisable request body
 * @param {object} [opts]
 * @param {number} [opts.timeout]  - socket idle timeout in ms (default 60 000)
 * @param {string} [opts.hostname] - override hostname (useful for tests)
 * @param {number} [opts.port]     - override port (useful for tests)
 * @param {boolean} [opts.rejectUnauthorized] - TLS cert check (default true)
 * @returns {Promise<object>} parsed JSON response
 */
function tgApi(token, method, body, opts = {}) {
  const {
    timeout = DEFAULT_TIMEOUT_MS,
    hostname = "api.telegram.org",
    port,
    rejectUnauthorized,
  } = opts;

  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    const data = JSON.stringify(body);
    const reqOpts = {
      hostname,
      path: `/bot${token}/${method}`,
      method: "POST",
      timeout,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
    };
    if (port != null) reqOpts.port = port;
    if (rejectUnauthorized != null) reqOpts.rejectUnauthorized = rejectUnauthorized;

    const req = https.request(reqOpts, (res) => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (buf += c));
      res.on("aborted", () => settle(reject, new Error(`Telegram API ${method} response aborted`)));
      res.on("error", (err) => settle(reject, err));
      res.on("end", () => {
        try {
          settle(resolve, JSON.parse(buf));
        } catch {
          settle(resolve, { ok: false, error: buf });
        }
      });
    });
    req.on("timeout", () => {
      req.destroy(new Error(`Telegram API ${method} timed out`));
    });
    req.on("error", (err) => settle(reject, err));
    req.write(data);
    req.end();
  });
}

module.exports = { tgApi, DEFAULT_TIMEOUT_MS };

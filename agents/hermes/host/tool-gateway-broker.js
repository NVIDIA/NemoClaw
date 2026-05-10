#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/* global fetch, URLSearchParams */

/**
 * Host-side Hermes managed-tool gateway broker.
 *
 * Hermes managed tools need a Nous subscription credential, but the sandbox
 * must not own raw Nous OAuth state. NemoClaw stores the refresh credential in
 * OpenShell provider storage, generates sandbox .env placeholders, and lets
 * OpenShell resolve the placeholder into an auth header when the sandbox calls
 * this broker. The broker refreshes on the host with x-nous-refresh-token,
 * injects a short-lived access token upstream, and persists only a refresh-token
 * hash so rotated refresh tokens can update OpenShell without writing raw
 * OAuth/API secrets to ~/.nemoclaw.
 */

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawnSync } = require("child_process");

const PORT = parseInt(process.env.HERMES_TOOL_GATEWAY_PORT || "11436", 10);
const STATE_DIR = process.env.HERMES_TOOL_GATEWAY_STATE_DIR;
const MATRIX_PATH =
  process.env.HERMES_TOOL_GATEWAY_MATRIX_PATH ||
  path.join(__dirname, "managed-tool-gateway-matrix.json");
const PORTAL_BASE_URL = (
  process.env.NOUS_PORTAL_BASE_URL || "https://portal.nousresearch.com"
).replace(/\/+$/, "");
const CLIENT_ID = process.env.HERMES_TOOL_GATEWAY_CLIENT_ID || "hermes-cli";
const OPENSHELL_BIN = process.env.NEMOCLAW_OPENSHELL_BIN || "openshell";
const CREDENTIAL_ENV =
  process.env.HERMES_TOOL_GATEWAY_REFRESH_CREDENTIAL_ENV ||
  "NEMOCLAW_HERMES_TOOL_GATEWAY_REFRESH_TOKEN";

if (!STATE_DIR) {
  console.error("HERMES_TOOL_GATEWAY_STATE_DIR required");
  process.exit(1);
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const DECODED_RESPONSE_HEADERS = new Set(["content-encoding", "content-length", "content-md5"]);
const STRIPPED_SECRET_HEADERS = new Set([
  "authorization",
  "cookie",
  "x-api-key",
  "api-key",
  "x-browser-use-api-key",
  "openai-api-key",
  "x-fal-key",
  "x-firecrawl-api-key",
]);
const TOKEN_HEADERS = [
  "x-api-key",
  "api-key",
  "x-browser-use-api-key",
  "openai-api-key",
  "x-fal-key",
  "x-firecrawl-api-key",
];

const accessTokenCache = new Map();

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function loadMatrix() {
  try {
    const matrix = JSON.parse(fs.readFileSync(MATRIX_PATH, "utf8"));
    return Object.fromEntries(
      Object.values(matrix)
        .filter((entry) => entry && typeof entry === "object")
        .map((entry) => [entry.service, entry])
        .filter(([service, entry]) => {
          return typeof service === "string" && typeof entry.upstream === "string";
        }),
    );
  } catch (error) {
    console.error(`failed to load Hermes tool gateway matrix: ${error.message || error}`);
    process.exit(1);
  }
}

const MATRIX = loadMatrix();

function stateFiles() {
  try {
    return fs
      .readdirSync(STATE_DIR)
      .filter((name) => name.endsWith(".json"))
      .map((name) => path.join(STATE_DIR, name));
  } catch {
    return [];
  }
}

function loadStateFile(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    if (!parsed.refresh_token_sha256 || !parsed.provider_name) return null;
    return { file, state: parsed };
  } catch {
    return null;
  }
}

function findStateByRefreshToken(refreshToken) {
  const digest = sha256(refreshToken);
  for (const file of stateFiles()) {
    const loaded = loadStateFile(file);
    if (!loaded) continue;
    if (timingSafeEqualString(String(loaded.state.refresh_token_sha256 || ""), digest)) {
      return loaded;
    }
  }
  return null;
}

function timingSafeEqualString(a, b) {
  const aBuf = Buffer.from(String(a || ""));
  const bBuf = Buffer.from(String(b || ""));
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function extractRefreshToken(req) {
  const auth = req.headers.authorization;
  if (typeof auth === "string") {
    const match = auth.match(/^(?:Bearer|Key)\s+(.+)$/i);
    if (match) return match[1].trim();
  }
  for (const headerName of TOKEN_HEADERS) {
    const value = req.headers[headerName];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (Array.isArray(value) && value.length > 0) return String(value[0]).trim();
  }
  return null;
}

function parseRoute(reqUrl) {
  const url = new URL(reqUrl || "/", "http://broker.local");
  const parts = url.pathname.split("/").filter(Boolean);
  const service = parts[0] || "";
  const entry = MATRIX[service];
  if (!entry) return null;
  const upstreamBase = String(entry.upstream).replace(/\/+$/, "");
  const suffix = "/" + parts.slice(1).join("/");
  return {
    service,
    entry,
    upstreamUrl: upstreamBase + (suffix === "/" ? "/" : suffix) + (url.search || ""),
  };
}

function tokenExpiresSoon(cacheEntry) {
  if (!cacheEntry?.expiresAt) return true;
  return cacheEntry.expiresAt - Date.now() < 120_000;
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${Date.now()}.${Math.random()
      .toString(36)
      .slice(2)}.tmp`,
  );
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

function updateOpenshellRefreshProvider(state, refreshToken) {
  const providerName = String(state.provider_name || "");
  if (!providerName) return;
  const result = spawnSync(
    OPENSHELL_BIN,
    ["provider", "update", providerName, "--credential", CREDENTIAL_ENV],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, [CREDENTIAL_ENV]: refreshToken },
      timeout: 30_000,
    },
  );
  if (result.status !== 0) {
    throw Object.assign(new Error("openshell_provider_update_failed"), {
      code: "openshell_provider_update_failed",
    });
  }
}

async function refreshAccessToken(refreshToken, loaded) {
  const digest = sha256(refreshToken);
  const cached = accessTokenCache.get(digest);
  if (cached?.accessToken && !tokenExpiresSoon(cached)) {
    return cached.accessToken;
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: loaded.state.client_id || CLIENT_ID,
  });
  const resp = await fetch(`${PORTAL_BASE_URL}/api/oauth/token`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "x-nous-refresh-token": refreshToken,
    },
    body,
  });

  if (!resp.ok) {
    const code = resp.status === 400 || resp.status === 401 ? "reauth_required" : "refresh_failed";
    throw Object.assign(new Error(`refresh_failed_http_${resp.status}`), { code });
  }

  const payload = await resp.json();
  if (!payload?.access_token) {
    throw Object.assign(new Error("token_response_missing_access_token"), {
      code: "refresh_failed",
    });
  }

  const expiresIn =
    typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in)
      ? payload.expires_in
      : 900;
  const nextRefreshToken =
    typeof payload.refresh_token === "string" && payload.refresh_token
      ? payload.refresh_token
      : refreshToken;
  const nextDigest = sha256(nextRefreshToken);
  accessTokenCache.delete(digest);
  accessTokenCache.set(nextDigest, {
    accessToken: payload.access_token,
    expiresAt: Date.now() + expiresIn * 1000,
  });

  if (nextDigest !== digest) {
    updateOpenshellRefreshProvider(loaded.state, nextRefreshToken);
    const nextState = {
      ...loaded.state,
      refresh_token_sha256: nextDigest,
      rotated_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    atomicWriteJson(loaded.file, nextState);
    loaded.state = nextState;
  }

  return payload.access_token;
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function buildForwardHeaders(req, route, accessToken) {
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase();
    if (lower === "host" || lower === "content-length" || lower === "accept-encoding") continue;
    if (HOP_BY_HOP_HEADERS.has(lower) || STRIPPED_SECRET_HEADERS.has(lower)) continue;
    headers[name] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  headers["accept-encoding"] = "identity";
  switch (route.service) {
    case "browser-use":
      headers["X-Browser-Use-API-Key"] = accessToken;
      break;
    case "fal-queue":
      headers.authorization = `Key ${accessToken}`;
      break;
    default:
      headers.authorization = `Bearer ${accessToken}`;
      break;
  }
  return headers;
}

function forwardResponseHeaders(upstreamResp) {
  const headers = {};
  upstreamResp.headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (
      HOP_BY_HOP_HEADERS.has(lower) ||
      DECODED_RESPONSE_HEADERS.has(lower) ||
      lower === "set-cookie"
    ) {
      return;
    }
    headers[name] = value;
  });
  return headers;
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendText(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function errorCode(err) {
  return err && typeof err === "object" && typeof err.code === "string" ? err.code : null;
}

async function handleProxy(req, res, route) {
  const refreshToken = extractRefreshToken(req);
  if (!refreshToken) {
    sendText(res, 401, "Hermes managed tools require Nous Portal OAuth. Re-run nemohermes onboard --resume.");
    return;
  }
  if (refreshToken.startsWith("openshell:resolve:env:")) {
    sendText(res, 401, "OpenShell did not resolve the Hermes tool-gateway credential placeholder.");
    return;
  }

  const loaded = findStateByRefreshToken(refreshToken);
  if (!loaded) {
    sendText(res, 401, "Unknown Hermes tool-gateway credential. Re-run nemohermes onboard --resume.");
    return;
  }

  let accessToken;
  try {
    accessToken = await refreshAccessToken(refreshToken, loaded);
  } catch (err) {
    const code = errorCode(err);
    if (code === "reauth_required") {
      sendText(
        res,
        401,
        "Nous OAuth refresh failed. Re-run nemohermes onboard --resume to re-authorize managed tools.",
      );
      return;
    }
    console.error(`Hermes tool gateway refresh failed: ${code || "refresh_failed"}`);
    sendText(res, 502, "Hermes tool gateway could not refresh host-side OAuth.");
    return;
  }

  let body;
  try {
    body = await readRequestBody(req);
  } catch {
    sendText(res, 400, "failed to read request body");
    return;
  }

  let upstreamResp;
  try {
    upstreamResp = await fetch(route.upstreamUrl, {
      method: req.method,
      headers: buildForwardHeaders(req, route, accessToken),
      body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
      redirect: "manual",
    });
  } catch {
    sendText(res, 502, "upstream gateway request failed");
    return;
  }

  const buffer = Buffer.from(await upstreamResp.arrayBuffer());
  res.writeHead(upstreamResp.status, forwardResponseHeaders(upstreamResp));
  res.end(buffer);
}

const server = http.createServer((req, res) => {
  Promise.resolve()
    .then(async () => {
      if (req.url === "/health") {
        sendJson(res, 200, {
          ok: true,
          services: Object.keys(MATRIX).sort(),
        });
        return;
      }
      const route = parseRoute(req.url);
      if (!route) {
        sendText(res, 404, "unknown Hermes managed-tool gateway route");
        return;
      }
      await handleProxy(req, res, route);
    })
    .catch((err) => {
      console.error(`Hermes tool gateway internal error: ${err?.message || err}`);
      if (!res.headersSent) {
        sendText(res, 500, "Hermes tool gateway internal error");
      } else {
        res.end();
      }
    });
});

server.listen(PORT, "0.0.0.0", () => {
  console.error(`Hermes managed-tool gateway broker listening on :${PORT}`);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));

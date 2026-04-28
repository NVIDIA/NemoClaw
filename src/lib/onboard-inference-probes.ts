// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Inference endpoint probes — validate that a provider's API responds
// before committing the onboard wizard to a model selection.

const { normalizeCredentialValue } = require("./credentials");
const { isWsl } = require("./platform");
const httpProbe = require("./http-probe");
const {
  isNvcfFunctionNotFoundForAccount,
  nvcfFunctionNotFoundMessage,
  shouldForceCompletionsApi,
} = require("./validation");

const { getCurlTimingArgs, runCurlProbe, runStreamingEventProbe } = httpProbe;

// ── Helpers ──────────────────────────────────────────────────────

function parseJsonObject(body) {
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function hasResponsesToolCall(body) {
  const parsed = parseJsonObject(body);
  if (!parsed || !Array.isArray(parsed.output)) return false;

  const stack = [...parsed.output];
  while (stack.length > 0) {
    const item = stack.pop();
    if (!item || typeof item !== "object") continue;
    if (item.type === "function_call" || item.type === "tool_call") return true;
    if (Array.isArray(item.content)) {
      stack.push(...item.content);
    }
  }

  return false;
}

function shouldRequireResponsesToolCalling(provider) {
  return (
    provider === "nvidia-prod" || provider === "gemini-api" || provider === "compatible-endpoint"
  );
}

// Google Gemini rejects requests that carry both an Authorization: Bearer
// The Gemini OpenAI-compat endpoint at /v1beta/openai/ requires
// `Authorization: Bearer <KEY>` and rejects `?key=<KEY>` with HTTP 400
// "Missing or invalid Authorization header." The dual-auth rejection
// described in #1960 applies to the native /v1beta/models/...:generateContent
// endpoint, which the onboarder probes do not use. Both callers of this
// helper (probeOpenAiLikeEndpoint, probeResponsesToolCalling) target the
// OpenAI-compat URL, so returning undefined for every provider is correct:
// probes default to Bearer auth and Gemini onboarding succeeds.
function getProbeAuthMode(_provider) {
  return undefined;
}

// Per-validation-probe curl timing. Tighter than the default 60s in
// getCurlTimingArgs() because validation must not hang the wizard for a
// minute on a misbehaving model. See issue #1601 (Bug 3).
function getValidationProbeCurlArgs(opts) {
  if (isWsl(opts)) {
    return ["--connect-timeout", "20", "--max-time", "30"];
  }
  return ["--connect-timeout", "10", "--max-time", "15"];
}

// ── Responses API probe ──────────────────────────────────────────

function probeResponsesToolCalling(endpointUrl, model, apiKey, options = {}) {
  const useQueryParam = options.authMode === "query-param";
  const normalizedKey = apiKey ? normalizeCredentialValue(apiKey) : "";
  const baseUrl = String(endpointUrl).replace(/\/+$/, "");
  const authHeader = !useQueryParam && normalizedKey
    ? ["-H", `Authorization: Bearer ${normalizedKey}`]
    : [];
  const url = useQueryParam && normalizedKey
    ? `${baseUrl}/responses?key=${encodeURIComponent(normalizedKey)}`
    : `${baseUrl}/responses`;
  const result = runCurlProbe([
    "-sS",
    ...getValidationProbeCurlArgs(),
    "-H",
    "Content-Type: application/json",
    ...authHeader,
    "-d",
    JSON.stringify({
      model,
      input: "Call the emit_ok function with value OK. Do not answer with plain text.",
      tool_choice: "required",
      tools: [
        {
          type: "function",
          name: "emit_ok",
          description: "Returns the probe value for validation.",
          parameters: {
            type: "object",
            properties: {
              value: { type: "string" },
            },
            required: ["value"],
            additionalProperties: false,
          },
        },
      ],
    }),
    url,
  ]);

  if (!result.ok) {
    return result;
  }
  if (hasResponsesToolCall(result.body)) {
    return result;
  }
  return {
    ok: false,
    httpStatus: result.httpStatus,
    curlStatus: result.curlStatus,
    body: result.body,
    stderr: result.stderr,
    message: `HTTP ${result.httpStatus}: Responses API did not return a tool call`,
  };
}

// ── OpenAI-like probe ────────────────────────────────────────────
// eslint-disable-next-line complexity
function probeOpenAiLikeEndpoint(endpointUrl, model, apiKey, options = {}) {
  const useQueryParam = options.authMode === "query-param";
  const normalizedKey = apiKey ? normalizeCredentialValue(apiKey) : "";
  const baseUrl = String(endpointUrl).replace(/\/+$/, "");
  const authHeader = !useQueryParam && normalizedKey
    ? ["-H", `Authorization: Bearer ${normalizedKey}`]
    : [];
  const appendKey = (urlPath) =>
    useQueryParam && normalizedKey ? `${baseUrl}${urlPath}?key=${encodeURIComponent(normalizedKey)}` : `${baseUrl}${urlPath}`;

  const responsesProbe =
    options.requireResponsesToolCalling === true
      ? {
          name: "Responses API with tool calling",
          api: "openai-responses",
          execute: () => probeResponsesToolCalling(endpointUrl, model, apiKey, { authMode: options.authMode }),
        }
      : {
          name: "Responses API",
          api: "openai-responses",
          execute: () =>
            runCurlProbe([
              "-sS",
              ...getValidationProbeCurlArgs(),
              "-H",
              "Content-Type: application/json",
              ...authHeader,
              "-d",
              JSON.stringify({
                model,
                input: "Reply with exactly: OK",
              }),
              appendKey("/responses"),
            ]),
        };

  const chatCompletionsProbe = {
    name: "Chat Completions API",
    api: "openai-completions",
    execute: () =>
      runCurlProbe([
        "-sS",
        ...getValidationProbeCurlArgs(),
        "-H",
        "Content-Type: application/json",
        ...authHeader,
        "-d",
        JSON.stringify({
          model,
          messages: [{ role: "user", content: "Reply with exactly: OK" }],
        }),
        appendKey("/chat/completions"),
      ]),
  };

  // NVIDIA Build does not expose /v1/responses; probing it always returns
  // "404 page not found" and only adds noise to error messages. Skip it
  // entirely for that provider. See issue #1601.
  const probes = options.skipResponsesProbe
    ? [chatCompletionsProbe]
    : [responsesProbe, chatCompletionsProbe];

  const failures = [];
  for (const probe of probes) {
    const result = probe.execute();
    if (result.ok) {
      // Streaming event validation — catch backends like SGLang that return
      // valid non-streaming responses but emit incomplete SSE events in
      // streaming mode. Only run for /responses probes on custom endpoints
      // where probeStreaming was requested.
      if (probe.api === "openai-responses" && options.probeStreaming === true) {
        const streamResult = runStreamingEventProbe([
          "-sS",
          ...getValidationProbeCurlArgs(),
          "-H",
          "Content-Type: application/json",
          ...authHeader,
          "-d",
          JSON.stringify({
            model,
            input: "Reply with exactly: OK",
            stream: true,
          }),
          appendKey("/responses"),
        ]);
        if (!streamResult.ok && streamResult.missingEvents.length > 0) {
          // Backend responds but lacks required streaming events — fall back
          // to /chat/completions silently.
          console.log(`  ℹ ${streamResult.message}`);
          failures.push({
            name: probe.name + " (streaming)",
            httpStatus: 0,
            curlStatus: 0,
            message: streamResult.message,
            body: "",
          });
          continue;
        }
        if (!streamResult.ok) {
          // Transport or execution failure — surface as a hard error instead
          // of silently switching APIs.
          return {
            ok: false,
            message: `${probe.name} (streaming): ${streamResult.message}`,
            failures: [
              {
                name: probe.name + " (streaming)",
                httpStatus: 0,
                curlStatus: 0,
                message: streamResult.message,
                body: "",
              },
            ],
          };
        }
      }
      return { ok: true, api: probe.api, label: probe.name };
    }
    // Preserve the raw response body alongside the summarized message so the
    // NVCF "Function not found for account" detector below can fall back to
    // the raw body if summarizeProbeError ever stops surfacing the marker
    // through `message`.
    failures.push({
      name: probe.name,
      httpStatus: result.httpStatus,
      curlStatus: result.curlStatus,
      message: result.message,
      body: result.body,
    });
  }

  // Single retry with doubled timeouts on timeout/connection failure.
  // WSL2's virtualized network stack can cause the initial probe to time out
  // before the TLS handshake completes. See issue #987.
  const isTimeoutOrConnFailure = (cs) => cs === 28 || cs === 6 || cs === 7;
  let retriedAfterTimeout = false;
  if (failures.length > 0 && isTimeoutOrConnFailure(failures[0].curlStatus)) {
    retriedAfterTimeout = true;
    const baseArgs = getValidationProbeCurlArgs();
    const doubledArgs = baseArgs.map((arg) =>
      /^\d+$/.test(arg) ? String(Number(arg) * 2) : arg,
    );
    const retryResult = runCurlProbe([
      "-sS",
      ...doubledArgs,
      "-H",
      "Content-Type: application/json",
      ...(apiKey ? ["-H", `Authorization: Bearer ${normalizeCredentialValue(apiKey)}`] : []),
      "-d",
      JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply with exactly: OK" }],
      }),
      `${String(endpointUrl).replace(/\/+$/, "")}/chat/completions`,
    ]);
    if (retryResult.ok) {
      return { ok: true, api: "openai-completions", label: "Chat Completions API" };
    }
  }

  // Detect the NVCF "Function not found for account" error and reframe it
  // with an actionable next step instead of dumping the raw NVCF body.
  // See issue #1601 (Bug 2).
  const accountFailure = failures.find(
    (failure) =>
      isNvcfFunctionNotFoundForAccount(failure.message) ||
      isNvcfFunctionNotFoundForAccount(failure.body),
  );
  if (accountFailure) {
    return {
      ok: false,
      message: nvcfFunctionNotFoundMessage(model),
      failures,
    };
  }

  const baseMessage = failures.map((failure) => `${failure.name}: ${failure.message}`).join(" | ");
  const wslHint =
    isWsl() && retriedAfterTimeout
      ? " · WSL2 detected \u2014 network verification may be slower than expected. " +
        "Run `nemoclaw onboard` with the `--skip-verify` flag if this endpoint is known to be reachable."
      : "";
  return {
    ok: false,
    message: baseMessage + wslHint,
    failures,
  };
}

// ── Anthropic probe ──────────────────────────────────────────────

function probeAnthropicEndpoint(endpointUrl, model, apiKey) {
  const result = runCurlProbe([
    "-sS",
    ...getCurlTimingArgs(),
    "-H",
    `x-api-key: ${normalizeCredentialValue(apiKey)}`,
    "-H",
    "anthropic-version: 2023-06-01",
    "-H",
    "content-type: application/json",
    "-d",
    JSON.stringify({
      model,
      max_tokens: 16,
      messages: [{ role: "user", content: "Reply with exactly: OK" }],
    }),
    `${String(endpointUrl).replace(/\/+$/, "")}/v1/messages`,
  ]);
  if (result.ok) {
    return { ok: true, api: "anthropic-messages", label: "Anthropic Messages API" };
  }
  return {
    ok: false,
    message: result.message,
    failures: [
      {
        name: "Anthropic Messages API",
        httpStatus: result.httpStatus,
        curlStatus: result.curlStatus,
        message: result.message,
      },
    ],
  };
}

module.exports = {
  parseJsonObject,
  hasResponsesToolCall,
  shouldRequireResponsesToolCalling,
  getProbeAuthMode,
  getValidationProbeCurlArgs,
  probeResponsesToolCalling,
  probeOpenAiLikeEndpoint,
  probeAnthropicEndpoint,
};

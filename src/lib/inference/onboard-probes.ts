// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Inference endpoint probes — validate that a provider's API responds
// before committing the onboard wizard to a model selection.
//
// @ts-nocheck is kept because this module is a CommonJS-style probe driver
// that bridges to ../credentials/store, ../platform, ../trace,
// ../validation, ./onboard-host-docker-internal, and the HTTP adapter via
// require() so the file can be evaluated by both the compiled CLI under
// dist/ and the source-only Vitest harnesses (test/helpers/onboard-script-
// mocks.cjs) without an extra build step. TypeScript would not resolve the
// require()-imported shapes without first migrating the credentials/store,
// platform, and trace modules to typed ESM exports, which is tracked
// separately and is intentionally out of scope for this credential-leak
// fix. The credential-handling surface that this PR introduces lives in
// the typed auth-config and provider-models modules, both of which are
// fully type-checked. Removal condition: once credentials/store, platform,
// and trace expose typed ESM entries, drop this directive and convert the
// require() calls to imports.

const {
  getCredential,
  normalizeCredentialValue,
  resolveProviderCredential,
} = require("../credentials/store");
const { isWsl } = require("../platform");
const httpProbe = require("../adapters/http/probe");
const authConfigModule = require("../adapters/http/auth-config");
const {
  getHostDockerInternalProbeFailure,
  isHijackedDockerInternalUrl,
} = require("./onboard-host-docker-internal");
const { isNvcfFunctionNotFoundForAccount, nvcfFunctionNotFoundMessage } = require("../validation");
const {
  executeProbeWithHttpRetry,
  isProbeTimeout,
  isTimeoutOrConnFailureStatus,
  RETRIABLE_HTTP_PROBE_STATUSES,
  runChatCompletionsRetryLoop,
} = require("./probe-retry");
const { probeAnthropicEndpoint } = require("./probe-anthropic");

const {
  getCurlTimingArgs,
  runCurlProbe,
  runChatCompletionsStreamingProbe,
  runStreamingEventProbe,
} = httpProbe;
const { createOpenAiLikeAuthConfig } = authConfigModule;

function buildOpenAiLikeAuthConfig(apiKey, options = {}) {
  const normalizedKey = apiKey ? normalizeCredentialValue(apiKey) : "";
  return createOpenAiLikeAuthConfig(normalizedKey, options.authMode);
}

// Convert an exception from the curl auth-config setup boundary (mkdtempSync,
// chmodSync, writeFileSync) into the same structured probe-failure shape that
// runCurlProbe surfaces, so a temp-file failure never escapes as an uncaught
// throw to the onboard wizard. See PR #5975 review note PRA-2.
function probeFailureFromError(error) {
  return {
    ok: false,
    httpStatus: 0,
    curlStatus: 0,
    message: error instanceof Error ? error.message : String(error),
  };
}

function openAiLikeFailureFromError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    message,
    failures: [{ name: "curl auth config", httpStatus: 0, curlStatus: 0, message, body: "" }],
  };
}

// ── Helpers ──────────────────────────────────────────────────────

const ONBOARD_VALIDATION_TIMEOUT_ENV = "NEMOCLAW_ONBOARD_VALIDATION_TIMEOUT_SECONDS";
const EXTENDED_NVIDIA_ENDPOINT_VALIDATION_MODELS = new Set([
  "qwen/qwen3.5-397b-a17b",
  "deepseek-ai/deepseek-v4-flash",
]);

// Hostnames that are normally meant for the sandbox/container host boundary.
// host.openshell.internal only resolves inside the OpenShell sandbox network,
// so host-side validation cannot prove reachability for that URL. For ordinary
// verification we still skip these endpoints, but strict tool-call validation
// must fail closed unless the host is probeable from the onboard process.
const SANDBOX_INTERNAL_HOSTS = ["host.openshell.internal"];

function isSandboxInternalUrl(url) {
  try {
    const { hostname } = new URL(String(url));
    return SANDBOX_INTERNAL_HOSTS.includes(hostname);
  } catch {
    return false;
  }
}

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

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasValidFunctionCallPayload(value) {
  if (!value || typeof value !== "object") return false;
  if (typeof value.name !== "string" || value.name.length === 0) return false;
  if (!hasOwn(value, "arguments")) return false;
  return (
    typeof value.arguments === "string" ||
    (typeof value.arguments === "object" &&
      value.arguments !== null &&
      !Array.isArray(value.arguments))
  );
}

function isStructuredChatCompletionsToolCall(value) {
  if (!value || typeof value !== "object") return false;
  if (value.type !== "function") return false;
  return hasValidFunctionCallPayload(value.function);
}

function containsToolCallLikeValue(value) {
  if (!value || typeof value !== "object") return false;
  if (hasValidFunctionCallPayload(value)) return true;
  if (isStructuredChatCompletionsToolCall(value)) return true;
  if (Array.isArray(value.tool_calls)) {
    return value.tool_calls.some((call) => isStructuredChatCompletionsToolCall(call));
  }
  if (value.message && typeof value.message === "object") {
    return containsToolCallLikeValue(value.message);
  }
  if (Array.isArray(value.choices)) {
    return value.choices.some((choice) => choice && containsToolCallLikeValue(choice));
  }
  return false;
}

function parseStringifiedToolCall(content) {
  if (typeof content !== "string") return null;
  const trimmed = content.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return containsToolCallLikeValue(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function hasChatCompletionsToolCall(body) {
  const parsed = parseJsonObject(body);
  const message = parsed?.choices?.[0]?.message;
  if (!message || typeof message !== "object") return false;
  const toolCalls = message.tool_calls;
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return false;
  return toolCalls.some((call) => isStructuredChatCompletionsToolCall(call));
}

function hasChatCompletionsToolCallLeak(body) {
  const parsed = parseJsonObject(body);
  const message = parsed?.choices?.[0]?.message;
  if (!message || typeof message !== "object") return false;

  const content = message.content;
  if (typeof content === "string") {
    return Boolean(parseStringifiedToolCall(content));
  }
  if (Array.isArray(content)) {
    return content.some((item) => {
      if (!item || typeof item !== "object") return false;
      const text = typeof item.text === "string" ? item.text : "";
      return Boolean(parseStringifiedToolCall(text));
    });
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
  const args = isWsl(opts)
    ? ["--connect-timeout", "20", "--max-time", "30"]
    : ["--connect-timeout", "10", "--max-time", "15"];
  return withValidationMaxTimeOverride(args);
}

function getDeepSeekV4ProValidationProbeCurlArgs(opts) {
  const args = isWsl(opts)
    ? ["--connect-timeout", "30", "--max-time", "150"]
    : ["--connect-timeout", "20", "--max-time", "120"];
  return withValidationMaxTimeOverride(args);
}

function getKimiK26ValidationProbeCurlArgs(opts) {
  const args = isWsl(opts)
    ? ["--connect-timeout", "20", "--max-time", "90"]
    : ["--connect-timeout", "10", "--max-time", "60"];
  return withValidationMaxTimeOverride(args);
}

function getExtendedNvidiaEndpointValidationProbeCurlArgs(opts) {
  const args = isWsl(opts)
    ? ["--connect-timeout", "30", "--max-time", "300"]
    : ["--connect-timeout", "10", "--max-time", "300"];
  return withValidationMaxTimeOverride(args);
}

function getCurlMaxTimeSeconds(args) {
  const maxTimeIndex = args.indexOf("--max-time");
  if (maxTimeIndex === -1) return 30;
  const value = Number(args[maxTimeIndex + 1]);
  return Number.isFinite(value) && value > 0 ? value : 30;
}

function withValidationMaxTimeOverride(args) {
  const raw = (process.env[ONBOARD_VALIDATION_TIMEOUT_ENV] || "").trim();
  if (!raw) return args;
  const overrideSeconds = Math.ceil(Number(raw));
  if (!Number.isFinite(overrideSeconds) || overrideSeconds <= 0) return args;
  if (overrideSeconds <= getCurlMaxTimeSeconds(args)) return args;
  const maxTimeIndex = args.indexOf("--max-time");
  if (maxTimeIndex === -1) return args;
  const next = [...args];
  next[maxTimeIndex + 1] = String(overrideSeconds);
  return next;
}

function getProbeProcessTimeoutMs(args) {
  return (getCurlMaxTimeSeconds(args) + 5) * 1000;
}

// ── Responses API probe ──────────────────────────────────────────

function probeResponsesToolCalling(endpointUrl, model, apiKey, options = {}) {
  const baseUrl = String(endpointUrl).replace(/\/+$/, "");
  let authConfig;
  try {
    authConfig = buildOpenAiLikeAuthConfig(apiKey, options);
    const result = runCurlProbe(
      [
        "-sS",
        ...getValidationProbeCurlArgs(),
        "-H",
        "Content-Type: application/json",
        ...authConfig.args,
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
        `${baseUrl}/responses`,
      ],
      { trustedConfigFiles: authConfig.trustedConfigFiles },
    );

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
  } catch (error) {
    return probeFailureFromError(error);
  } finally {
    authConfig?.cleanup();
  }
}

function probeChatCompletionsToolCalling(endpointUrl, model, apiKey, options = {}) {
  const baseUrl = String(endpointUrl).replace(/\/+$/, "");
  let authConfig;
  try {
    authConfig = buildOpenAiLikeAuthConfig(apiKey, options);
    const timingArgs = options.timingArgs ?? getChatCompletionsProbeTimingArgs(model);
    const args = [
      "-sS",
      ...timingArgs,
      "-H",
      "Content-Type: application/json",
      ...authConfig.args,
      "-d",
      JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content:
              "You are a tool-calling assistant. When tools are available and the user asks for an action, call a tool.",
          },
          {
            role: "user",
            content:
              "Send hello to the current session. Use the sessions_send tool and do not answer in plain text.",
          },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "sessions_send",
              description: "Send a message to the active chat session.",
              parameters: {
                type: "object",
                properties: { message: { type: "string" } },
                required: ["message"],
                additionalProperties: false,
              },
            },
          },
          {
            type: "function",
            function: {
              name: "memory_search",
              description: "Search memory for relevant prior context.",
              parameters: {
                type: "object",
                properties: { query: { type: "string" } },
                required: ["query"],
                additionalProperties: false,
              },
            },
          },
          {
            type: "function",
            function: {
              name: "web_fetch",
              description: "Fetch a URL and summarize the result.",
              parameters: {
                type: "object",
                properties: { url: { type: "string" } },
                required: ["url"],
                additionalProperties: false,
              },
            },
          },
        ],
        tool_choice: "required",
        temperature: 0,
        // Bound strict tool-call probes so a slow local model cannot keep
        // generating until the host-side curl process timeout kills validation.
        // This strict gate is currently used for Local Ollama; if it expands to
        // reasoning models, add a thinking-suppression carve-out before lowering
        // this cap so reasoning traces cannot consume the whole budget (#4537).
        max_tokens: 256,
        stream: false,
      }),
      `${baseUrl}/chat/completions`,
    ];
    const result = runCurlProbe(args, {
      timeoutMs: getProbeProcessTimeoutMs(args),
      trustedConfigFiles: authConfig.trustedConfigFiles,
    });

    if (!result.ok) {
      return result;
    }
    if (hasChatCompletionsToolCall(result.body)) {
      return result;
    }
    if (hasChatCompletionsToolCallLeak(result.body)) {
      return {
        ok: false,
        httpStatus: result.httpStatus,
        curlStatus: result.curlStatus,
        body: result.body,
        stderr: result.stderr,
        message:
          `HTTP ${result.httpStatus}: Chat Completions leaked tool calls into plain text content. ` +
          "Use an endpoint/runtime that returns structured tool_calls (for Hermes on local inference, " +
          "prefer vLLM with --tool-call-parser hermes).",
      };
    }
    return {
      ok: false,
      httpStatus: result.httpStatus,
      curlStatus: result.curlStatus,
      body: result.body,
      stderr: result.stderr,
      message: `HTTP ${result.httpStatus}: Chat Completions did not return a tool call`,
    };
  } catch (error) {
    return probeFailureFromError(error);
  } finally {
    authConfig?.cleanup();
  }
}

// ── OpenAI-like probe ────────────────────────────────────────────
function isDeepSeekV4ProModel(model) {
  return String(model || "").toLowerCase() === "deepseek-ai/deepseek-v4-pro";
}

function isKimiK26Model(model) {
  return String(model || "").toLowerCase() === "moonshotai/kimi-k2.6";
}

function needsExtendedNvidiaEndpointValidationBudget(model) {
  return EXTENDED_NVIDIA_ENDPOINT_VALIDATION_MODELS.has(String(model || "").toLowerCase());
}

function getChatCompletionsProbeTimingArgs(model, opts) {
  if (isDeepSeekV4ProModel(model)) return getDeepSeekV4ProValidationProbeCurlArgs(opts);
  if (isKimiK26Model(model)) return getKimiK26ValidationProbeCurlArgs(opts);
  if (needsExtendedNvidiaEndpointValidationBudget(model)) {
    return getExtendedNvidiaEndpointValidationProbeCurlArgs(opts);
  }
  return getValidationProbeCurlArgs(opts);
}

function getChatCompletionsProbePayload(model) {
  const payload = {
    model,
    messages: [{ role: "user", content: "Reply with exactly: OK" }],
    max_tokens: 8,
  };

  if (isDeepSeekV4ProModel(model)) {
    return {
      ...payload,
      temperature: 1,
      top_p: 0.95,
      max_tokens: 8192,
      chat_template_kwargs: { thinking: false },
      stream: true,
    };
  }

  if (isKimiK26Model(model)) {
    return {
      ...payload,
      max_tokens: 8,
      chat_template_kwargs: { thinking: false },
    };
  }

  return payload;
}

// credentialArgs is the curl argument slice that carries the auth credential
// for the probe — typically ["--config", <tmpfile>] from the auth-config
// module. The parameter used to be named `authHeader` and used to receive a
// raw `-H "Authorization: Bearer ..."` slice, but inline credential headers
// are now rejected by validateCurlProbeArgs. Tests may still pass an
// inline-header slice (no credential boundary applies to test fakes), so the
// parameter remains a plain string[]. See PR #5975 review note PRA-4.
export function getChatCompletionsProbeCurlArgs(opts: {
  credentialArgs?: readonly string[];
  authHeader?: readonly string[];
  model: string;
  url: string;
  isWsl?: boolean;
}) {
  const { credentialArgs, authHeader, model, url, isWsl: isWslOverride } = opts;
  const platformOptions = typeof isWslOverride === "boolean" ? { isWsl: isWslOverride } : undefined;
  const timingArgs = getChatCompletionsProbeTimingArgs(model, platformOptions);
  const credSlice = credentialArgs ?? authHeader ?? [];
  return [
    "-sS",
    ...timingArgs,
    "-H",
    "Content-Type: application/json",
    ...credSlice,
    "-d",
    JSON.stringify(getChatCompletionsProbePayload(model)),
    url,
  ];
}

function runChatCompletionsProbe({
  credentialArgs,
  model,
  url,
  isWsl: isWslOverride,
  trustedConfigFiles,
}) {
  const args = getChatCompletionsProbeCurlArgs({
    credentialArgs,
    model,
    url,
    isWsl: isWslOverride,
  });
  const probeOpts = { timeoutMs: getProbeProcessTimeoutMs(args) };
  if (trustedConfigFiles && trustedConfigFiles.length > 0) {
    probeOpts.trustedConfigFiles = trustedConfigFiles;
  }
  if (isDeepSeekV4ProModel(model)) {
    return runChatCompletionsStreamingProbe(args, probeOpts);
  }
  return runCurlProbe(args, probeOpts);
}

// Extracted from probeOpenAiLikeEndpoint so the chat-completions retry path
// can be tested independently. Doubles the timing args (--connect-timeout,
// --max-time) and replays through the same backoff schedule as transient HTTP
// statuses. See PR #5975 review note PRA-8.
function runDoubledTimeoutChatCompletionsRetry({
  endpointUrl,
  model,
  apiKey,
  options,
  baseUrl,
  authConfig,
}) {
  const platformOptions = typeof options.isWsl === "boolean" ? { isWsl: options.isWsl } : undefined;
  const baseArgs = getChatCompletionsProbeTimingArgs(model, platformOptions);
  const doubledArgs = baseArgs.map((arg) => (/^\d+$/.test(arg) ? String(Number(arg) * 2) : arg));
  const buildRetryArgs = () => [
    "-sS",
    ...doubledArgs,
    "-H",
    "Content-Type: application/json",
    ...authConfig.args,
    "-d",
    JSON.stringify(getChatCompletionsProbePayload(model)),
    `${baseUrl}/chat/completions`,
  ];
  const runRetryProbe = () =>
    options.requireChatCompletionsToolCalling === true
      ? probeChatCompletionsToolCalling(endpointUrl, model, apiKey, {
          authMode: options.authMode,
          timingArgs: doubledArgs,
        })
      : (() => {
          const retryArgs = buildRetryArgs();
          return runCurlProbe(retryArgs, {
            timeoutMs: getProbeProcessTimeoutMs(retryArgs),
            trustedConfigFiles: authConfig.trustedConfigFiles,
          });
        })();
  return runChatCompletionsRetryLoop(runRetryProbe);
}

function probeOpenAiLikeEndpoint(endpointUrl, model, apiKey, options = {}) {
  if (isHijackedDockerInternalUrl(endpointUrl) && options.allowHostDockerInternal !== true) {
    return getHostDockerInternalProbeFailure();
  }

  if (isSandboxInternalUrl(endpointUrl)) {
    const { hostname } = new URL(String(endpointUrl));
    if (options.requireChatCompletionsToolCalling !== true) {
      return {
        ok: true,
        api: null,
        label: null,
        note: `${hostname} only resolves inside the sandbox — validation skipped. If the endpoint is unreachable at runtime, re-run onboard with a routable URL.`,
      };
    }
    return {
      ok: false,
      message: `${hostname} only resolves inside the sandbox and cannot be validated for required structured Chat Completions tool calls from the host. Use a routable endpoint URL and retry onboard.`,
      failures: [
        {
          name: "Chat Completions API with tool calling",
          httpStatus: 0,
          curlStatus: 0,
          message: "sandbox-internal endpoint cannot be strictly validated from host",
          body: "",
        },
      ],
    };
  }

  const baseUrl = String(endpointUrl).replace(/\/+$/, "");
  let authConfig;
  try {
    authConfig = buildOpenAiLikeAuthConfig(apiKey, options);
    const responsesProbe =
      options.requireResponsesToolCalling === true
        ? {
            name: "Responses API with tool calling",
            api: "openai-responses",
            execute: () =>
              probeResponsesToolCalling(endpointUrl, model, apiKey, { authMode: options.authMode }),
          }
        : {
            name: "Responses API",
            api: "openai-responses",
            execute: () =>
              runCurlProbe(
                [
                  "-sS",
                  ...getValidationProbeCurlArgs(),
                  "-H",
                  "Content-Type: application/json",
                  ...authConfig.args,
                  "-d",
                  JSON.stringify({
                    model,
                    input: "Reply with exactly: OK",
                  }),
                  `${baseUrl}/responses`,
                ],
                { trustedConfigFiles: authConfig.trustedConfigFiles },
              ),
          };

    const chatCompletionsProbe = {
      name: "Chat Completions API",
      api: "openai-completions",
      execute: () =>
        options.requireChatCompletionsToolCalling === true
          ? probeChatCompletionsToolCalling(endpointUrl, model, apiKey, {
              authMode: options.authMode,
            })
          : runChatCompletionsProbe({
              credentialArgs: authConfig.args,
              model,
              url: `${baseUrl}/chat/completions`,
              isWsl: options.isWsl,
              trustedConfigFiles: authConfig.trustedConfigFiles,
            }),
    };

    // NVIDIA Build does not expose /v1/responses; probing it always returns
    // "404 page not found" and only adds noise to error messages. Skip it
    // entirely for that provider. See issue #1601.
    const probes = options.skipResponsesProbe
      ? [chatCompletionsProbe]
      : [responsesProbe, chatCompletionsProbe];

    const failures = [];
    for (const probe of probes) {
      const result = executeProbeWithHttpRetry(probe);
      if (result.ok) {
        // Streaming event validation — catch backends like SGLang that return
        // valid non-streaming responses but emit incomplete SSE events in
        // streaming mode. Only run for /responses probes on custom endpoints
        // where probeStreaming was requested.
        //
        // Removal condition: once the SGLang Responses API streaming
        // implementation emits the OpenAI `response.output_text.delta` event
        // shape (tracked upstream in sgl-project/sglang for the OpenAI-compat
        // Responses surface), drop this fallback and treat any non-ok
        // streaming probe as a hard failure. The accompanying integration
        // test "falls back to chat-completions when /responses streaming
        // lacks required events" in onboard-probes.test.ts pins the current
        // fallback shape so a future removal stays observable. See PR #5975
        // review note PRA-14.
        if (probe.api === "openai-responses" && options.probeStreaming === true) {
          const streamResult = runStreamingEventProbe(
            [
              "-sS",
              ...getValidationProbeCurlArgs(),
              "-H",
              "Content-Type: application/json",
              ...authConfig.args,
              "-d",
              JSON.stringify({
                model,
                input: "Reply with exactly: OK",
                stream: true,
              }),
              `${baseUrl}/responses`,
            ],
            { trustedConfigFiles: authConfig.trustedConfigFiles },
          );
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
      if (
        probe.api === "openai-completions" &&
        isDeepSeekV4ProModel(model) &&
        isProbeTimeout(result)
      ) {
        const warning =
          "DeepSeek V4 Pro validation timed out before the stream returned data; continuing with NVIDIA Endpoints because this model can take longer than the onboarding probe budget to emit its first token.";
        console.log(`  ⚠ ${warning}`);
        return {
          ok: true,
          api: probe.api,
          label: probe.name,
          warning,
          validated: false,
        };
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

    // Retry with doubled timeouts on timeout/connection failure, using the same
    // backoff schedule as transient HTTP statuses. WSL2's virtualized network
    // stack can cause the initial probe to time out before the TLS handshake
    // completes (#987); hosted providers also occasionally drop connections for
    // tens of seconds during incidents (#3033).
    // Look across every failure entry rather than only failures[0] so a probe
    // ordering like /responses (HTTP error) followed by /chat/completions
    // (curl 28) still triggers the chat-completions retry path.
    let retriedAfterTimeout = false;
    if (failures.some((failure) => isTimeoutOrConnFailureStatus(failure.curlStatus))) {
      retriedAfterTimeout = true;
      const retryResult = runDoubledTimeoutChatCompletionsRetry({
        endpointUrl,
        model,
        apiKey,
        options,
        baseUrl,
        authConfig,
      });
      if (retryResult.ok) {
        return { ok: true, api: "openai-completions", label: "Chat Completions API" };
      }
      if (options.requireChatCompletionsToolCalling === true) {
        failures.push({
          name: "Chat Completions API with tool calling (retry)",
          httpStatus: retryResult.httpStatus,
          curlStatus: retryResult.curlStatus,
          message: retryResult.message,
          body: retryResult.body,
        });
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

    const baseMessage = failures
      .map((failure) => `${failure.name}: ${failure.message}`)
      .join(" | ");
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
  } catch (error) {
    return openAiLikeFailureFromError(error);
  } finally {
    authConfig?.cleanup();
  }
}

// ── Anthropic probe ──────────────────────────────────────────────

module.exports = {
  isSandboxInternalUrl,
  isHijackedDockerInternalUrl,
  parseJsonObject,
  hasResponsesToolCall,
  hasChatCompletionsToolCall,
  hasChatCompletionsToolCallLeak,
  shouldRequireResponsesToolCalling,
  getProbeAuthMode,
  getValidationProbeCurlArgs,
  getDeepSeekV4ProValidationProbeCurlArgs,
  getKimiK26ValidationProbeCurlArgs,
  getChatCompletionsProbePayload,
  getChatCompletionsProbeCurlArgs,
  probeResponsesToolCalling,
  probeChatCompletionsToolCalling,
  probeOpenAiLikeEndpoint,
  probeAnthropicEndpoint,
  RETRIABLE_HTTP_PROBE_STATUSES,
};

export function shouldSmokeOpenAiLikeOnboardRoute(
  provider: string,
  credentialEnv: string | null = null,
) {
  const {
    HERMES_INFERENCE_CREDENTIAL_ENV,
    HERMES_PROVIDER_NAME,
  } = require("../hermes-provider-auth");
  // Hermes Provider OAuth mints a short-lived agent key and stores it with
  // OpenShell provider storage. A host-side direct probe would resolve the
  // ambient OPENAI_API_KEY instead, which can falsely fail after successful
  // OAuth if the user's shell has a different OpenAI key staged. The Nous API
  // key path still has a host credential and should keep the direct smoke.
  // Remove this exception once the host smoke can resolve the actual Hermes
  // OAuth agent key from OpenShell provider storage.
  if (provider === HERMES_PROVIDER_NAME && credentialEnv === HERMES_INFERENCE_CREDENTIAL_ENV) {
    return false;
  }
  const { REMOTE_PROVIDER_CONFIG } = require("../onboard/providers");
  if (provider === "nvidia-nim" || provider === "nvidia-router") return true;
  return Object.values(REMOTE_PROVIDER_CONFIG).some(
    (entry) => entry.providerName === provider && entry.providerType === "openai",
  );
}

export function verifyOnboardInferenceSmoke(options: any) {
  if (
    !options.forceOpenAiLike &&
    !shouldSmokeOpenAiLikeOnboardRoute(options.provider, options.credentialEnv)
  ) {
    return;
  }
  if (process.env.VITEST === "true") return;

  const endpointUrl = options.endpointUrl || require("./config").INFERENCE_ROUTE_URL;
  const credentialEnv = options.credentialEnv || null;
  const apiKey = credentialEnv
    ? resolveProviderCredential(credentialEnv) || getCredential(credentialEnv) || ""
    : "";
  const probe = probeOpenAiLikeEndpoint(endpointUrl, options.model, apiKey, {
    authMode: getProbeAuthMode(options.provider),
    skipResponsesProbe: true,
  });

  if (probe.ok) {
    console.log(`  ✓ Inference smoke passed: ${options.provider} / ${options.model}`);
    return;
  }

  const { compactText } = require("../core/url-utils");
  const { redact } = require("../runner");
  console.error("  Onboard inference smoke check failed.");
  console.error(`  Provider: ${options.provider}`);
  console.error(`  Model: ${options.model}`);
  console.error(`  API base: ${endpointUrl}`);
  if (credentialEnv) console.error("  Credential env: configured");
  console.error(
    `  Upstream error: ${compactText(redact(probe.message || "unknown inference failure"))}`,
  );
  process.exit(1);
}

module.exports.shouldSmokeOpenAiLikeOnboardRoute = shouldSmokeOpenAiLikeOnboardRoute;
module.exports.verifyOnboardInferenceSmoke = verifyOnboardInferenceSmoke;

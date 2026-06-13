// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure validation and failure-classification functions.
 *
 * No I/O, no side effects — takes strings/numbers in, returns typed results.
 */

export interface ValidationClassification {
  kind: "transport" | "credential" | "model" | "endpoint" | "unknown";
  retry: "retry" | "credential" | "model" | "selection";
}

export interface SandboxCreateFailure {
  kind:
    | "image_transfer_timeout"
    | "image_transfer_reset"
    | "image_upload_container_missing"
    | "sandbox_create_incomplete"
    | "tls_cert_mismatch"
    | "gpu_cdi_injection_failed"
    | "unknown";
  uploadedToGateway: boolean;
}

export interface SandboxCreateRecoveryPlan {
  /**
   * Emit the Linux ARM64 (aarch64) local-registry / image-ref workaround for
   * the misleading "failed to upload image tar into container" Docker 404. The
   * gateway container is healthy; OpenShell's large-tar upload path is the
   * problem, and pushing the built image to a local registry then creating
   * from the image ref bypasses it. See #3266.
   */
  arm64ImageRefWorkaround: boolean;
}

export interface GatewayStartFailure {
  /**
   * - `docker_unreachable`: the underlying Docker daemon (Colima on macOS,
   *   dockerd on Linux) is not responding. Retrying the openshell health
   *   poll cannot recover from this — the user must start Docker first.
   * - `unknown`: any other failure; callers should fall through to the
   *   normal retry/health-wait behavior.
   */
  kind: "docker_unreachable" | "unknown";
}

export function classifyValidationFailure({
  httpStatus = 0,
  curlStatus = 0,
  message = "",
} = {}): ValidationClassification {
  const normalized = String(message).replace(/\s+/g, " ").trim().toLowerCase();
  if (curlStatus) {
    return { kind: "transport", retry: "retry" };
  }
  if (httpStatus === 429 || (httpStatus >= 500 && httpStatus < 600)) {
    return { kind: "transport", retry: "retry" };
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return { kind: "credential", retry: "credential" };
  }
  // Credential-bearing error messages take precedence over the HTTP 400
  // "model" default because some providers (notably Google Gemini) return
  // HTTP 400 with "API key expired. Please renew the API key." — without
  // this check the onboard flow skips the key re-entry prompt and loops
  // back to provider selection. See #1942.
  if (
    /api key (expired|not valid)|api[_ ]key[_ ]invalid|unauthorized|forbidden|invalid api key|invalid_auth|permission/i.test(
      normalized,
    )
  ) {
    return { kind: "credential", retry: "credential" };
  }
  if (httpStatus === 400) {
    return { kind: "model", retry: "model" };
  }
  if (/model.+not found|unknown model|unsupported model|bad model/i.test(normalized)) {
    return { kind: "model", retry: "model" };
  }
  if (httpStatus === 404 || httpStatus === 405) {
    return { kind: "endpoint", retry: "selection" };
  }
  if (/unauthorized|forbidden|invalid api key|invalid_auth|permission/i.test(normalized)) {
    return { kind: "credential", retry: "credential" };
  }
  if (/ssl|tls|certificate|handshake/i.test(normalized)) {
    return { kind: "transport", retry: "retry" };
  }
  return { kind: "unknown", retry: "selection" };
}

export function classifyApplyFailure(message = ""): ValidationClassification {
  return classifyValidationFailure({ message });
}

export function classifySandboxCreateFailure(output = ""): SandboxCreateFailure {
  const text = String(output || "");
  const uploadedToGateway =
    /\[progress\]\s+Uploaded to gateway/i.test(text) ||
    /Image .*available in the gateway/i.test(text);

  if (/failed to read image export stream|Timeout error/i.test(text)) {
    return { kind: "image_transfer_timeout", uploadedToGateway };
  }
  if (/Connection reset by peer/i.test(text)) {
    return { kind: "image_transfer_reset", uploadedToGateway };
  }
  if (
    /invalid peer certificate|BadSignature|handshake verification failed|certificate verify failed|SSL certificate problem|x509: certificate|unknown authority/i.test(
      text,
    )
  ) {
    return { kind: "tls_cert_mismatch", uploadedToGateway };
  }
  // Misleading "container does not exist" 404 raised while OpenShell streams the
  // built image tar into the (healthy) gateway container. Reported on Linux
  // ARM64 with large images: the gateway is up and a same-size archive PUT
  // succeeds directly, so the Docker 404 is a symptom of the tar-upload path,
  // not a missing gateway. Match the distinctive upload-tar phrase, or the
  // combined 404 + container-missing + gateway-container-name shape. See #3266.
  if (
    /failed to upload image tar into container/i.test(text) ||
    (/status code 404/i.test(text) &&
      /(container does not exist|no container with name or ID)/i.test(text) &&
      /openshell-cluster-nemoclaw/i.test(text))
  ) {
    return { kind: "image_upload_container_missing", uploadedToGateway };
  }
  if (
    /(CDI device injection failed|unresolvable CDI devices?)[^\n]*nvidia\.com\/gpu/i.test(text) ||
    /nvidia\.com\/gpu[^\n]*(CDI device injection failed|unresolvable CDI devices?)/i.test(text)
  ) {
    return { kind: "gpu_cdi_injection_failed", uploadedToGateway };
  }
  if (/Created sandbox:/i.test(text)) {
    return { kind: "sandbox_create_incomplete", uploadedToGateway: true };
  }
  return { kind: "unknown", uploadedToGateway };
}

/**
 * Decide how to recover from a classified sandbox-create failure. Pure: takes
 * the classification plus the host platform/arch, returns a typed plan. Kept
 * separate from the I/O hint printer so the retry/workaround decision can be
 * unit-tested without spying on the console.
 *
 * Today the only special-cased recovery is the Linux ARM64 image-tar-upload
 * 404 (#3266); every other failure leaves the plan flags false so callers fall
 * through to the existing generic resume guidance.
 */
export function planSandboxCreateRecovery(
  failure: SandboxCreateFailure,
  {
    platform = process.platform,
    arch = process.arch,
  }: { platform?: NodeJS.Platform; arch?: NodeJS.Architecture } = {},
): SandboxCreateRecoveryPlan {
  return {
    arm64ImageRefWorkaround:
      failure.kind === "image_upload_container_missing" && platform === "linux" && arch === "arm64",
  };
}

/**
 * Classify a non-zero `openshell gateway start` result so the onboard retry
 * loop can short-circuit on unrecoverable failures.
 *
 * The only case we special-case today is "Docker daemon not reachable" — on
 * macOS this surfaces as `Socket not found: /var/run/docker.sock` (Colima
 * stopped) and on Linux as `Cannot connect to the Docker daemon at
 * unix:///var/run/docker.sock. Is the docker daemon running?`. Retrying the
 * health poll against a stopped daemon wastes ~5–15 minutes and produces an
 * unactionable error at the end; bailing out immediately with a clear
 * "start Docker" message is strictly better UX. See NemoClaw #2347.
 */
export function classifyGatewayStartFailure(output = ""): GatewayStartFailure {
  const text = String(output || "");
  // Match both macOS (Colima / Docker Desktop) and Linux docker daemon-down
  // signatures. The openshell CLI echoes these verbatim from the underlying
  // Docker client error when the gateway controller starts.
  if (
    /Socket not found:\s*\/var\/run\/docker\.sock/i.test(text) ||
    /Cannot connect to the Docker daemon/i.test(text) ||
    /^\s*(?:Error:\s*)?Failed to create Docker client(?:[.:]|\b)/im.test(text) ||
    /docker daemon.*(is not running|not responding|unreachable)/i.test(text)
  ) {
    return { kind: "docker_unreachable" };
  }
  return { kind: "unknown" };
}

export function validateNvidiaApiKeyValue(
  key: string,
  credentialEnv: string = "NVIDIA_INFERENCE_API_KEY",
): string | null {
  // The nvapi- prefix check is specific to NVIDIA keys; skip it for keys
  // from other providers (e.g. ANTHROPIC_API_KEY, OPENAI_API_KEY) so that
  // a valid Anthropic key is not rejected with an NVIDIA-specific error.
  const isNvidia =
    credentialEnv === "NVIDIA_INFERENCE_API_KEY" || credentialEnv === "NVIDIA_API_KEY";
  if (!key) {
    return isNvidia ? "  NVIDIA API Key is required." : "  API Key is required.";
  }
  if (isNvidia && !key.startsWith("nvapi-")) {
    return "  Invalid NVIDIA API key. Must start with nvapi-";
  }
  return null;
}

export function isSafeModelId(value: string): boolean {
  return /^[A-Za-z0-9._:/-]+$/.test(value);
}

/**
 * Detect NVIDIA Cloud Functions "Function not found for account" errors.
 *
 * NVIDIA Build (integrate.api.nvidia.com) returns this when a model is in the
 * public catalog but is not deployed for the caller's account/org. The raw
 * body looks like:
 *
 *   {"status":404,"title":"Not Found",
 *    "detail":"Function '<uuid>': Not found for account '<account-id>'"}
 *
 * Detecting this lets the wizard surface an actionable error instead of the
 * raw NVCF body. See issue #1601.
 */
export function isNvcfFunctionNotFoundForAccount(message: string): boolean {
  return /Function\s+'[^']+':\s*Not found for account/i.test(String(message || ""));
}

/**
 * Build the user-facing message for an NVCF "Function not found for account"
 * failure. The model is in the catalog but cannot be invoked from this key.
 *
 * The wording deliberately starts with "Model '<id>' not found" so that
 * `classifyValidationFailure()` matches its `model.+not found` regex and
 * routes the user into the model-selection recovery path instead of
 * collapsing to the generic `unknown`/`selection` branch.
 */
export function nvcfFunctionNotFoundMessage(model: string): string {
  return (
    `Model '${model}' not found — it is in the NVIDIA Build catalog but is not deployed ` +
    "for your account. Pick a different model, or check the model card on " +
    "https://build.nvidia.com to see if it requires org-level access."
  );
}

/**
 * Whether the wizard should skip probing the OpenAI Responses API entirely
 * for the given inference provider. NVIDIA Build does not expose
 * `/v1/responses` for any model — every probe to that path returns
 * "404 page not found". Google Gemini also does not support the Responses
 * API. Skipping the probe removes wasted round-trips and stops the
 * failure-message noise from leaking into chat-completions errors.
 * See issue #1601 (Bug 1) and issue #1960.
 */
export function shouldSkipResponsesProbe(provider: string): boolean {
  return provider === "nvidia-prod" || provider === "nvidia-nim" || provider === "gemini-api";
}

/**
 * Whether the caller has explicitly requested the chat completions API path.
 * Pass the value of `NEMOCLAW_PREFERRED_API` (or any other source). This lets
 * users with backends that expose `/v1/responses` but lack full streaming-event
 * support (e.g. SGLang) skip the Responses API probe during onboarding.
 */
export function shouldForceCompletionsApi(preferredApi?: string): boolean {
  const value = (preferredApi || "").trim().toLowerCase();
  return value === "openai-completions" || value === "chat-completions";
}

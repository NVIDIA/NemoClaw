// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Retry only connection/transfer propagation signals observed at this boundary.
// Proxy, TLS, certificate, CA, and cipher failures stay terminal because blind
// retries cannot repair their security or configuration cause.
const TRANSIENT_CURL_EXIT_CODES = [6, 7, 28, 52, 55, 56] as const;
const SUCCESS_HTTP_STATUS_MIN = 200;
const SUCCESS_HTTP_STATUS_MAX = 299;
const RETRYABLE_HTTP_STATUS_MIN = 500;
const RETRYABLE_HTTP_STATUS_MAX = 599;

export function classifyCurlExit(code: number): "transient" | "permanent" {
  return TRANSIENT_CURL_EXIT_CODES.some((candidate) => candidate === code)
    ? "transient"
    : "permanent";
}

export function isRetryableHttpStatus(status: number): boolean {
  // Keep 429 terminal: this probe does not retain Retry-After. A blind replay
  // cannot honor service recovery and would amplify load during rate limiting;
  // fail closed so an operator can retry onboarding after the limit clears.
  return status >= RETRYABLE_HTTP_STATUS_MIN && status <= RETRYABLE_HTTP_STATUS_MAX;
}

export function isSuccessfulHttpStatus(status: number): boolean {
  return status >= SUCCESS_HTTP_STATUS_MIN && status <= SUCCESS_HTTP_STATUS_MAX;
}

export function totalRetryBackoffSeconds(attempts: number, delaySeconds: number): number {
  // Sum delaySeconds * i for each gap i between attempts: 5s + 10s for 3 attempts.
  return (delaySeconds * attempts * (attempts - 1)) / 2;
}

export const RETRYABLE_HTTP_STATUS_PYTHON_EXPRESSION = `${RETRYABLE_HTTP_STATUS_MIN} <= http_status_code <= ${RETRYABLE_HTTP_STATUS_MAX}`;
export const SUCCESS_HTTP_STATUS_PYTHON_EXPRESSION = `${SUCCESS_HTTP_STATUS_MIN} <= http_status_code <= ${SUCCESS_HTTP_STATUS_MAX}`;

export function buildCompatibleEndpointSmokeRequestScript(): string {
  const transientExitPattern = TRANSIENT_CURL_EXIT_CODES.join(" | ");
  return String.raw`
run_smoke_request() {
  curl -sS --connect-timeout 10 --max-time "$SMOKE_REQUEST_TIMEOUT_SECONDS" \
    -o "$response_file" -w '%{http_code}' \
    "$INFERENCE_URL" \
    -H "Content-Type: application/json" \
    -d "@$payload_file" >"$status_file" 2>/dev/null || {
    rc=$?
    printf 'curl exit %s\n' "$rc" >&2
    case "$rc" in
      ${transientExitPattern})
        if [ "$rc" -eq 28 ]; then
          printf 'curl timeout (exit 28); retrying with the same bounded request timeout\n' >&2
        fi
        return 4
        ;;
      *) return 1 ;;
    esac
  }
}`.trim();
}

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { isCredentialShapedName } from "../../security/credential-env";
import { ROOT } from "../../state/paths";

export interface CurlProbeArgOptions {
  cwd?: string;
  trustedConfigFiles?: readonly string[];
  /**
   * Permit redirect-following flags (`-L`, `-sfL`, `--location`) for this probe.
   * Opt-in per call site because following redirects on a user-supplied URL
   * widens the SSRF surface; only enable for probes against a fixed,
   * hardcoded host.
   */
  allowRedirects?: boolean;
}

const CURL_CONFIG_OPTIONS = new Set(["--config", "-K"]);
const CURL_OPTIONS_THAT_READ_FILES = new Set([
  "--cookie",
  "-b",
  "--netrc-file",
  "--upload-file",
  "-T",
  "--cert",
  "--key",
  "--proxy-cert",
  "--proxy-key",
]);
const CURL_OPTIONS_THAT_READ_IMPLICIT_FILES = new Set(["--netrc", "--netrc-optional"]);
const CURL_DATA_OPTIONS = new Set([
  "--data",
  "--data-raw",
  "--data-binary",
  "--data-ascii",
  "--data-urlencode",
  "--json",
  "--form",
  "-d",
  "-F",
]);
const CURL_HEADER_OPTIONS = new Set(["--header", "--proxy-header", "-H"]);
const CURL_SAFE_FLAG_OPTIONS = new Set([
  "-s",
  "-S",
  "-sS",
  "-sf",
  "-f",
  "--fail",
  "--silent",
  "--show-error",
  "--compressed",
  "--get",
]);
// Redirect-following flags are NOT globally safe — they widen the SSRF
// surface whenever a user-controlled URL is involved. Call sites that
// genuinely need to follow redirects from a fixed, hardcoded host (e.g. the
// Ollama manifest probe) must opt in via CurlProbeArgOptions.allowRedirects.
const CURL_REDIRECT_FLAG_OPTIONS = new Set(["-L", "-sfL", "--location"]);
const CURL_SAFE_VALUE_OPTIONS = new Set(["--connect-timeout", "--max-time", "-X", "--request"]);
const CURL_FORBIDDEN_MULTI_TRANSFER_OPTIONS = new Set(["--next"]);
const CURL_SHORT_OPTIONS_WITH_VALUES = new Set(["-K", "-b", "-T", "-d", "-F", "-H", "-X"]);

// Defence-in-depth: primary protection is routing all secrets through trusted
// --config tmpfiles. This denylist refuses URLs whose query-parameter names
// look credential-shaped, so a regression at the caller can never quietly
// leak a secret into the curl argv element. The credential-shaped test is
// shared with the curl probe environment scrubber (security/credential-env).
function isCredentialShapedQueryParam(name: string): boolean {
  return isCredentialShapedName(name);
}

function normalizeHttpProbeUrl(rawUrl: unknown): string {
  if (typeof rawUrl !== "string" || rawUrl.trim() === "") {
    throw new Error("curl probe URL is required");
  }
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`curl probe URL must use http or https: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error("curl probe URL must not embed credentials");
  }
  for (const param of url.searchParams.keys()) {
    if (isCredentialShapedQueryParam(param)) {
      throw new Error(
        `curl probe URL must not embed credentials in the ${param} query parameter; route via --config`,
      );
    }
  }
  return url.toString();
}

const CURL_FORBIDDEN_AUTH_HEADER_PREFIXES = [
  "authorization:",
  "proxy-authorization:",
  "x-api-key:",
  "x-goog-api-key:",
];

function assertHeaderCarriesNoSecret(option: string, value: string): void {
  const lower = value.toLowerCase().trimStart();
  for (const prefix of CURL_FORBIDDEN_AUTH_HEADER_PREFIXES) {
    if (lower.startsWith(prefix)) {
      throw new Error(
        `curl probe ${option} must not carry credentials inline; route the header via --config`,
      );
    }
  }
}

function splitCurlOptionArg(arg: string): { option: string; inlineValue?: string } {
  if (arg.startsWith("--")) {
    const [option, inlineValue] = arg.includes("=") ? arg.split(/=(.*)/s, 2) : [arg, undefined];
    return { option, inlineValue };
  }
  for (const option of CURL_SHORT_OPTIONS_WITH_VALUES) {
    if (arg.startsWith(option) && arg.length > option.length) {
      return { option, inlineValue: arg.slice(option.length) };
    }
  }
  return { option: arg };
}

function curlValueReadsFromFile(option: string, value: string): boolean {
  if ((value.startsWith("@") && value !== "@-") || /(^|=)@[^-]/.test(value)) return true;
  if (option === "--data-urlencode" && /^[^=]+@[^-]/.test(value)) return true;
  if ((option === "--form" || option === "-F") && /(^|=)<[^-]/.test(value)) return true;
  return false;
}

function curlHeaderValueReadsFromFile(value: string): boolean {
  return value.startsWith("@") && value !== "@-";
}

function getCurlOptionValue(
  args: string[],
  index: number,
  option: string,
  inlineValue: string | undefined,
): string {
  if (inlineValue !== undefined) return inlineValue;
  const value = args[index + 1];
  if (value === undefined) throw new Error(`curl probe option requires a value: ${option}`);
  return value;
}

function normalizeCurlConfigPath(value: string, opts: CurlProbeArgOptions): string {
  if (value.trim() === "") throw new Error("curl probe config path is required");
  if (value.includes("\0")) throw new Error("curl probe config path must not contain NUL bytes");
  return path.resolve(opts.cwd ?? ROOT, value);
}

function isTrustedCurlConfigPath(value: string, opts: CurlProbeArgOptions): boolean {
  if (!opts.trustedConfigFiles?.length) return false;
  const candidate = normalizeCurlConfigPath(value, opts);
  return opts.trustedConfigFiles
    .map((trustedPath) => normalizeCurlConfigPath(trustedPath, opts))
    .includes(candidate);
}

export function validateCurlProbeArgs(
  argv: string[],
  opts: CurlProbeArgOptions = {},
): { args: string[]; url: string } {
  const args = [...argv];
  const url = normalizeHttpProbeUrl(args.pop());
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const { option, inlineValue } = splitCurlOptionArg(arg);
    if (CURL_FORBIDDEN_MULTI_TRANSFER_OPTIONS.has(option)) {
      throw new Error(
        `curl probe option is not allowed because it creates multiple transfers: ${option}`,
      );
    }
    if (CURL_OPTIONS_THAT_READ_IMPLICIT_FILES.has(option)) {
      throw new Error(`curl probe option is not allowed because it reads local files: ${option}`);
    }
    if (CURL_OPTIONS_THAT_READ_FILES.has(option)) {
      getCurlOptionValue(args, index, option, inlineValue);
      if (inlineValue === undefined) index += 1;
      throw new Error(`curl probe option is not allowed because it reads local files: ${option}`);
    }
    if (CURL_CONFIG_OPTIONS.has(option)) {
      const value = getCurlOptionValue(args, index, option, inlineValue);
      if (!isTrustedCurlConfigPath(value, opts)) {
        throw new Error(`curl probe config file is not trusted: ${option}`);
      }
      if (inlineValue === undefined) index += 1;
      continue;
    }
    if (CURL_HEADER_OPTIONS.has(option)) {
      const value = getCurlOptionValue(args, index, option, inlineValue);
      if (curlHeaderValueReadsFromFile(value)) {
        throw new Error(`curl probe option must not read headers from a file: ${option}`);
      }
      assertHeaderCarriesNoSecret(option, value);
      if (inlineValue === undefined) index += 1;
      continue;
    }
    if (arg === "--url" || arg.startsWith("--url=")) {
      throw new Error("curl probe URLs must be passed as the final argv entry");
    }
    if (CURL_DATA_OPTIONS.has(option)) {
      const value = getCurlOptionValue(args, index, option, inlineValue);
      if (curlValueReadsFromFile(option, value)) {
        throw new Error(`curl probe option must not read request data from a file: ${option}`);
      }
      if (inlineValue === undefined) index += 1;
      continue;
    }
    if (CURL_SAFE_VALUE_OPTIONS.has(option)) {
      getCurlOptionValue(args, index, option, inlineValue);
      if (inlineValue === undefined) index += 1;
      continue;
    }
    if (CURL_SAFE_FLAG_OPTIONS.has(option)) {
      continue;
    }
    if (CURL_REDIRECT_FLAG_OPTIONS.has(option)) {
      if (!opts.allowRedirects) {
        throw new Error(
          `curl probe option is not allowed without explicit allowRedirects opt-in: ${option}`,
        );
      }
      continue;
    }
    if (!arg.startsWith("-")) {
      throw new Error("curl probe received unexpected positional argument before URL");
    }
    throw new Error(`curl probe option is not allowed: ${option}`);
  }
  return { args, url };
}

export function buildValidatedCurlCommandArgs(
  argv: string[],
  opts: CurlProbeArgOptions = {},
): string[] {
  const { args, url } = validateCurlProbeArgs(argv, opts);
  return [...args, url];
}

export type CurlProbeMode = "json" | "chat-stream" | "event-stream";

export function buildCurlProbeSpawnArgs(
  args: string[],
  url: string,
  bodyFile: string,
  mode: CurlProbeMode,
): string[] {
  const outputArgs =
    mode === "json" ? ["-o", bodyFile, "-w", "%{http_code}"] : ["-N", "-o", bodyFile];
  const statusArgs = mode === "chat-stream" ? ["-w", "%{http_code}"] : [];
  // lgtm[js/file-access-to-http] URL/argv are validated; file-backed config paths must be explicitly trusted.
  return [...args, ...outputArgs, ...statusArgs, url];
}

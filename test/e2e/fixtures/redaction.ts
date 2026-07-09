// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Fixture-owned secret hygiene at the spawn boundary.
 *
 * Spec ownership: redaction and child-env minimization are FIXTURE
 * INFRASTRUCTURE, not a per-action / per-script / per-workflow concern.
 * Children spawned by fixture command boundaries must (a) receive a minimal,
 * typed env (fixture allowlist + per-action declared `secretEnv`
 * passthrough only), and (b) have their stdout/stderr passed through
 * redaction before any byte reaches an evidence log or
 * PhaseResult.message. There is no opt-out flag, no env switch, no
 * helper that bypasses this. One execution mode, secrets always
 * redacted in evidence — same one-mode discipline that motivates the
 * rest of this PR.
 *
 * Pattern source-of-truth: src/lib/security/secret-patterns.ts. We
 * mirror the canonical regex sources here (validated by parity tests) so
 * fixture-layer redaction stays in lockstep with product-runtime redaction
 * without coupling the fixture layer to product runtime modules.
 *
 * Tests:
 *   test/e2e/support/e2e-redaction-entry.test.ts
 *   test/e2e/support/e2e-redaction-parity.test.ts
 *   test/e2e/support/e2e-phase-environment.test.ts
 *     - canonical token redaction parity with product runtime patterns
 *     - explicit per-test redaction values
 *     - child-env allowlist filtering for fixture probes
 */

import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";

const REDACTED = "<REDACTED>";
const EXPLICIT_REDACTED = "[REDACTED]";
// Keep the fixture-owned explicit sentinel stable when already-redacted output
// crosses another artifact boundary. Tight boundaries ensure a sentinel
// embedded in a longer credential value remains eligible for canonical
// redaction instead of becoming a bypass.
const SAFE_EXPLICIT_REDACTION_PATTERN = /(^|[\s=:,'"(]|\[|\{)\[REDACTED\](?=$|[\s,;:.'")\]}])/g;
const MANAGED_CREDENTIAL_REFERENCE_SOURCE = String.raw`(?:(?:Bearer[ \t]+)?openshell:resolve:env:(?:v[0-9]{1,20}_)?[A-Z][A-Z0-9_]{0,127}|(?:xoxb|xapp)-OPENSHELL-RESOLVE-ENV-(?:v[0-9]{1,20}_)?[A-Z][A-Z0-9_]{0,127})`;
const SAFE_QUOTED_CREDENTIAL_REFERENCE_PATTERN = new RegExp(
  `(["'])${MANAGED_CREDENTIAL_REFERENCE_SOURCE}\\1`,
  "g",
);
const SAFE_STANDALONE_CREDENTIAL_REFERENCE_PATTERN = new RegExp(
  `(^|[ \\t\\r\\n])${MANAGED_CREDENTIAL_REFERENCE_SOURCE}(?=$|[ \\t\\r\\n])`,
  "g",
);
const SAFE_ENV_ASSIGNMENT_PATTERN =
  /^[ \t]*(?:export[ \t]+)?([A-Z][A-Z0-9_]{0,127})[ \t]*=[ \t]*(?:(?:Bearer[ \t]+)?openshell:resolve:env:(?:v[0-9]{1,20}_)?\1|(?:xoxb|xapp)-OPENSHELL-RESOLVE-ENV-(?:v[0-9]{1,20}_)?\1)[ \t]*$/gm;

// Fixture-local mirror of src/lib/security/secret-patterns.ts. The
// fixture layer deliberately does not import from src/lib/security/ so it
// stays decoupled from product runtime modules and the cross-tsconfig
// boundary. A parity test
// (test/e2e/support/e2e-redaction-parity.test.ts)
// asserts these regex sources stay in lockstep with the canonical
// product source so adding a token shape there keeps both layers
// honest at once.
// Exported only so the parity test
// (test/e2e/support/e2e-redaction-parity.test.ts) can
// import the actual RegExp values rather than parsing source text.
// Production code in this module continues to use them via the local
// binding; nothing in the fixture runtime imports these.
export const TOKEN_PREFIX_PATTERNS: RegExp[] = [
  /nvapi-[A-Za-z0-9_-]{10,}/g,
  /nvcf-[A-Za-z0-9_-]{10,}/g,
  /ghp_[A-Za-z0-9_-]{10,}/g,
  /(?:github_pat_)[A-Za-z0-9_]{30,}/g,
  /sk-proj-[A-Za-z0-9_-]{10,}/g,
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /(?:xox[bpas]|xapp)-[A-Za-z0-9-]{10,}/g,
  /A(?:K|S)IA[A-Z0-9]{16}/g,
  /hf_[A-Za-z0-9]{10,}/g,
  /glpat-[A-Za-z0-9_-]{10,}/g,
  /gsk_[A-Za-z0-9]{10,}/g,
  /pypi-[A-Za-z0-9_-]{10,}/g,
  /\bbot\d{8,10}:[A-Za-z0-9_-]{35}\b/g,
  /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g,
  /\b[A-Za-z0-9]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}\b/g,
  // Tavily
  /tvly-[A-Za-z0-9_-]{10,}/g,
  // LangSmith (personal access tokens: lsv2_pt_<hash>; service keys: lsv2_sk_<hash>)
  // Match every underscore-delimited segment so redaction cannot expose a key tail.
  /lsv2_(?:pt|sk)_[A-Za-z0-9]{10,}(?:_[A-Za-z0-9]+)*/g,
];

export const CONTEXT_PATTERNS: RegExp[] = [
  /(?<=Bearer\s+)[A-Za-z0-9_.+/=-]{10,}/gi,
  /(?<=(?:^|[^A-Za-z0-9])(?:[A-Za-z0-9]{1,128}_(?:KEY|TOKEN|SECRET|CREDENTIAL|PASSWORD|PASSWD|PASS)|(?:X[-_])?API[-_]KEY|TOKEN|SECRET|CREDENTIAL|PASSWORD|PASSWD|PASS)["']?(?:[ \t]{0,32}[=:][ \t]{0,32}|[ \t]{1,32})["']?)[^\s'"]{10,}/gi,
  /(?<=(?:^|[^A-Za-z0-9])(?:[A-Za-z0-9]{1,128}(?:Token|Secret|Credential)|[A-Za-z0-9]{0,128}(?:[Aa]ccess|[Rr]efresh|[Cc]lient|[Bb]earer|[Aa]uth|[Aa][Pp][Ii]|[Pp]rivate|[Ss]igning|[Ss]ession|[Bb]ot|[Aa]pp|[Rr]esolved)Key|[A-Za-z0-9]{1,128}(?:Password|Passwd|Pass))["']?(?:[ \t]{0,32}[=:][ \t]{0,32}|[ \t]{1,32})["']?)[^\s'"]{10,}/g,
  /(?<=(?:^|[^A-Za-z0-9])KEY["']?(?:[ \t]{0,32}[=:][ \t]{0,32}|[ \t]{1,32})["']?)[^\s'"]{10,}/g,
];

export const SECRET_BLOCK_PATTERNS: RegExp[] = [
  /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )?PRIVATE KEY-----/g,
];

/**
 * Replace every secret-shaped token in `text` with `<REDACTED>`. Uses
 * the canonical TOKEN_PREFIX_PATTERNS + CONTEXT_PATTERNS sets.
 *
 * When `explicitValues` is supplied, each non-empty value is replaced
 * verbatim with `[REDACTED]` before the regex passes run, so per-test
 * secret literals (which may not match any canonical shape) are
 * scrubbed at the same single entry point. The distinct sentinel keeps
 * explicit-value hits visually separable from regex hits in artifacts.
 * Values are applied longest first so a value that contains a shorter
 * one cannot be exposed by ordering.
 *
 * Best-effort against unknown token shapes. The actual defense is the
 * env allowlist (buildChildEnv); pattern redaction catches what slips
 * through (e.g. error messages that echo a secret value).
 */
function redactCanonicalShapes(text: string): string {
  let out = text;
  for (const p of TOKEN_PREFIX_PATTERNS) {
    p.lastIndex = 0;
    out = out.replace(p, REDACTED);
  }
  for (const p of SECRET_BLOCK_PATTERNS) {
    p.lastIndex = 0;
    out = out.replace(p, REDACTED);
  }
  for (const p of CONTEXT_PATTERNS) {
    p.lastIndex = 0;
    out = out.replace(p, REDACTED);
  }
  return out;
}

function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function protectSafeRedactionValues(text: string): {
  protectedText: string;
  references: Array<{ marker: string; value: string }>;
} {
  let protectedText = text;
  const references: Array<{ marker: string; value: string }> = [];
  let markerPrefix: string;
  do {
    markerPrefix = `\uE000 ${randomUUID()} `;
  } while (text.includes(markerPrefix));
  const protect = (pattern: RegExp): void => {
    pattern.lastIndex = 0;
    protectedText = protectedText.replace(pattern, (value) => {
      const marker = `${markerPrefix}${references.length} \uE001`;
      references.push({ marker, value });
      return marker;
    });
  };
  protect(SAFE_EXPLICIT_REDACTION_PATTERN);
  protect(SAFE_ENV_ASSIGNMENT_PATTERN);
  protect(SAFE_QUOTED_CREDENTIAL_REFERENCE_PATTERN);
  protect(SAFE_STANDALONE_CREDENTIAL_REFERENCE_PATTERN);
  return { protectedText, references };
}

export function redactString(text: string, explicitValues?: Iterable<string>): string {
  if (!text) return text;
  let out = text;
  let explicitMarker: string | undefined;
  if (explicitValues) {
    const values = [
      ...new Set(Array.from(explicitValues).filter((value) => value && value.length > 0)),
    ];
    values.sort((a, b) => b.length - a.length);
    if (values.length > 0) {
      do {
        explicitMarker = `\uE002 ${randomUUID()} \uE003`;
      } while (text.includes(explicitMarker));
      const explicitPattern = new RegExp(values.map(escapeRegExpLiteral).join("|"), "g");
      out = out.replace(explicitPattern, explicitMarker);
    }
  }
  const { protectedText, references } = protectSafeRedactionValues(out);
  let redacted = redactCanonicalShapes(protectedText);
  for (const { marker, value } of references) {
    redacted = redacted.replace(marker, value);
  }
  if (explicitMarker) {
    redacted = redacted.split(explicitMarker).join(EXPLICIT_REDACTED);
  }
  return redacted;
}

// Env keys the fixture layer guarantees children may always see. Anything
// outside this set, outside FIXTURE_ENV_PREFIXES, and not declared
// in PhaseAction.secretEnv / AssertionStep.secretEnv is dropped before
// the child spawns.
const FIXTURE_ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "SHELL",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "TMPDIR",
  "RUNNER_TEMP",
  "RUNNER_OS",
  "GITHUB_ACTIONS",
  "CI",
  "NEMOCLAW_NON_INTERACTIVE",
  "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE",
  "NEMOCLAW_E2E_USE_HOSTED_INFERENCE",
  "NEMOCLAW_OPENSHELL_CHANNEL",
  "NEMOCLAW_TRACE_DIR",
]);

const FIXTURE_ENV_PREFIXES: readonly string[] = ["E2E_", "NEMOCLAW_LOG_"];

// Shape required of any declared secretEnv key — must look like a
// secret-bearing variable. Prevents accidental allowlisting of
// non-secret values via the secretEnv channel and keeps the
// "fixture-allowlist vs declared-secret" distinction honest.
const SECRET_ENV_KEY_SHAPE =
  /^(?:[A-Z][A-Z0-9_]*_)?(?:API[_]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|CREDENTIAL|PASSPHRASE|PRIVATE[_]?KEY|ACCESS[_]?KEY)$/;

export function isValidSecretEnvKey(key: string): boolean {
  return SECRET_ENV_KEY_SHAPE.test(key);
}

export interface BuildChildEnvOptions {
  /** Per-action / per-step declared secret-bearing env keys to pass through. */
  secretEnv?: readonly string[];
  /** Additional non-secret env keys required by a fixture-owned spawn helper. */
  additionalAllowedEnv?: readonly string[];
  /** Fixture-controlled overlay (E2E_CONTEXT_DIR, E2E_PHASE, E2E_*_ID). */
  fixtureOverlay: NodeJS.ProcessEnv;
}

/**
 * Build the child's env from `base` (typically `process.env`) by
 * keeping only:
 *   1. keys in FIXTURE_ENV_ALLOWLIST
 *   2. keys starting with one of FIXTURE_ENV_PREFIXES
 *   3. non-secret keys explicitly declared in `opts.additionalAllowedEnv`
 *   4. keys explicitly declared in `opts.secretEnv` (validated shape)
 * then layering `opts.fixtureOverlay` on top.
 *
 * Throws if a `secretEnv` entry doesn't match the secret-key shape;
 * better to fail loudly at compile/runtime than silently leak a
 * non-secret env var (which would defeat the allowlist purpose).
 */
export function buildChildEnv(
  base: NodeJS.ProcessEnv,
  opts: BuildChildEnvOptions,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (FIXTURE_ENV_ALLOWLIST.has(key)) {
      out[key] = value;
      continue;
    }
    if (FIXTURE_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      out[key] = value;
      continue;
    }
  }
  for (const key of opts.additionalAllowedEnv ?? []) {
    if (isValidSecretEnvKey(key)) {
      throw new Error(
        `additionalAllowedEnv entry '${key}' looks secret-bearing; use secretEnv ` +
          `so secret passthrough remains explicit.`,
      );
    }
    if (base[key] !== undefined) {
      out[key] = base[key];
    }
  }
  for (const key of opts.secretEnv ?? []) {
    if (!isValidSecretEnvKey(key)) {
      throw new Error(
        `secretEnv entry '${key}' does not match the secret-key shape ` +
          `(must end with API_KEY, TOKEN, SECRET, PASSWORD, PASSWD, PASS, CREDENTIAL, ` +
          `PASSPHRASE, PRIVATE_KEY, or ACCESS_KEY). Refusing to allowlist.`,
      );
    }
    if (base[key] !== undefined) {
      out[key] = base[key];
    }
  }
  Object.assign(out, opts.fixtureOverlay);
  // The install action drops nemoclaw / openshell shims under
  // ~/.local/bin (the historical repo-current install location).
  // On Ubuntu GH runners ~/.local/bin is on the default PATH; on
  // self-hosted GPU runners and inside WSL it often is not, so the
  // onboarding action's child runs without nemoclaw on PATH and
  // dies with 'nemoclaw: command not found'. Add ~/.local/bin to
  // every child's PATH at the fixture boundary so the install
  // location is consistent across phases. Idempotent equivalent of
  // the install-path-refresh.sh nemoclaw_ensure_local_bin_on_path
  // helper, applied centrally instead of per-script.
  const home = out.HOME ?? base.HOME;
  if (typeof home === "string" && home.length > 0) {
    const localBin = `${home}/.local/bin`;
    const currentPath = out.PATH ?? "";
    if (!currentPath.split(":").includes(localBin)) {
      out.PATH = currentPath ? `${localBin}:${currentPath}` : localBin;
    }
  }
  return out;
}

/**
 * Pipe `src` into `log`, redacting every chunk on the way through.
 * Optional `onChunk` receives the already-redacted text (used by the
 * orchestrator to keep a redacted stderr tail for failure messages).
 *
 * No raw bytes from the child ever reach `log` or the tail callback.
 */
export function pipeRedacted(
  src: Readable,
  log: Writable,
  onChunk?: (redactedChunk: string) => void,
): void {
  src.on("data", (chunk: Buffer) => {
    const redacted = redactString(chunk.toString("utf8"));
    log.write(redacted);
    onChunk?.(redacted);
  });
}

/**
 * Compact array of all fixture env keys the child sees by default.
 * Exported for tests/diagnostics; do not use to bypass the boundary.
 */
export function fixtureEnvAllowlistSnapshot(): {
  keys: string[];
  prefixes: string[];
} {
  return {
    keys: [...FIXTURE_ENV_ALLOWLIST].sort(),
    prefixes: [...FIXTURE_ENV_PREFIXES],
  };
}

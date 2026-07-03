// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Characterization of the onboarding session persistence SECRET BOUNDARY
 * (#6225, epic #6224).
 *
 * ~/.nemoclaw/onboard-session.json is the durable artifact `onboard --resume`
 * trusts, so its contract is that credential VALUES never reach disk:
 *
 *   - `credentialEnv` persists the env-var NAME only; the secret value stays
 *     in the process environment and is re-hydrated on resume
 *     (src/lib/state/onboard-session.ts).
 *   - `endpointUrl` is passed through redactUrl() (src/lib/security/redact.ts)
 *     both in filterSafeUpdates() and again in normalizeSession() on every
 *     save and load: userinfo stripped, sensitive-named query params masked,
 *     fragment removed; non-URL values fall back to redactSensitiveText().
 *   - `migratedLegacyValueHashes` stores sha256 hex digests keyed by env
 *     name, mirroring legacyValueHash() in src/lib/onboard.ts, never the
 *     migrated plaintext.
 *   - failure messages and per-step errors pass through redactSensitiveText().
 *
 * These tests PIN current behavior as a regression baseline. Sessions are
 * built through the real mutation/serialization functions (createSession,
 * saveSession, markStep*, loadSession) — never hand-written JSON — then the
 * raw persisted text is scanned for sentinel leakage and deserialized back.
 * Known gaps (the unset-vs-declined null ambiguity, benign-named query
 * params) are pinned as-is and annotated, deliberately not fixed here.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { Session } from "../src/lib/state/onboard-session";

const require = createRequire(import.meta.url);

// SESSION_DIR/SESSION_FILE are derived from HOME at module-load time, so the
// temp HOME must be in place before the session module loads. These CJS
// requires (via the integration project's source-require hook) execute here,
// after the assignment — unlike a hoisted static import.
const originalHome = process.env.HOME;
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-session-secret-"));
process.env.HOME = tempHome;

const session: typeof import("../src/lib/state/onboard-session") = require("../src/lib/state/onboard-session");
const stepMutation: typeof import("../src/lib/state/onboard-step-mutation") = require("../src/lib/state/onboard-step-mutation");

const restoreHome =
  originalHome === undefined
    ? () => {
        delete process.env.HOME;
      }
    : () => {
        process.env.HOME = originalHome;
      };

const originalCredentialValue = process.env.NVIDIA_API_KEY;
const restoreCredentialValue =
  originalCredentialValue === undefined
    ? () => {
        delete process.env.NVIDIA_API_KEY;
      }
    : () => {
        process.env.NVIDIA_API_KEY = originalCredentialValue;
      };

// Distinctive marker embedded in the sentinel so raw-text scans catch partial
// leakage, not just the intact token.
const SENTINEL_MARKER = "sentinel6225zqx";
// nvapi-shaped so every redactor tier (TOKEN_PREFIX_PATTERNS in
// src/lib/security/secret-patterns.ts) recognizes it as a secret wherever
// redaction is expected to fire.
const SENTINEL_SECRET = `nvapi-${SENTINEL_MARKER}-secret-value-do-not-persist`;
const SENTINEL_SHA256 = createHash("sha256").update(SENTINEL_SECRET).digest("hex");

const REDACTED_FAILURE_MESSAGE =
  "sandbox create failed: NVIDIA_API_KEY=<REDACTED> and Bearer <REDACTED>";

function readRawSessionText(): string {
  return fs.readFileSync(session.SESSION_FILE, "utf8");
}

function requireLoadedSession(): Session {
  const loaded = session.loadSession();
  expect(loaded).not.toBeNull();
  return loaded ?? session.createSession();
}

beforeEach(() => {
  session.clearSession();
  // The real secret value lives in the process environment during onboarding
  // (credential hydration reads it from there on resume). Keeping it staged
  // for every test proves the session layer never captures it ambiently.
  process.env.NVIDIA_API_KEY = SENTINEL_SECRET;
});

afterAll(() => {
  session.clearSession();
  restoreCredentialValue();
  restoreHome();
  fs.rmSync(tempHome, { recursive: true, force: true });
});

describe("onboard session persistence secret boundary (#6225)", () => {
  it("persists the credential env-var name only while the secret value stays in process.env", () => {
    // Guard: the module-scope HOME redirect must have taken effect, or the
    // scans below would read a session file outside the temp sandbox.
    expect(session.SESSION_DIR).toBe(path.join(tempHome, ".nemoclaw"));

    session.saveSession(session.createSession());
    session.markStepCompleteRecordOnly("provider_selection", {
      provider: "nvidia-prod",
      model: "nvidia/llama-3.1-nemotron-70b-instruct",
    });
    session.markStepCompleteRecordOnly("inference", {
      credentialEnv: "NVIDIA_API_KEY",
      endpointUrl: "https://integrate.api.nvidia.com/v1",
    });

    const raw = readRawSessionText();
    expect(raw).toContain('"credentialEnv": "NVIDIA_API_KEY"');
    expect(raw).not.toContain(SENTINEL_SECRET);
    expect(raw).not.toContain(SENTINEL_MARKER);

    const loaded = requireLoadedSession();
    expect(loaded.credentialEnv).toBe("NVIDIA_API_KEY");
    expect(loaded.provider).toBe("nvidia-prod");
    expect(loaded.endpointUrl).toBe("https://integrate.api.nvidia.com/v1");
  });

  it("keeps the sentinel secret out of every persisted field across a failed-run round-trip", () => {
    session.saveSession(session.createSession());
    session.markStepStartedRecordOnly("preflight");
    session.markStepCompleteRecordOnly("preflight");
    session.markStepStartedRecordOnly("gateway");
    session.markStepCompleteRecordOnly("gateway");
    session.markStepCompleteRecordOnly("provider_selection", {
      provider: "nvidia-prod",
      model: "nemotron-test",
    });
    session.markStepCompleteRecordOnly("inference", {
      credentialEnv: "NVIDIA_API_KEY",
      endpointUrl: `https://svc:${SENTINEL_SECRET}@api.example.com/v1?access_token=${SENTINEL_SECRET}`,
      migratedLegacyValueHashes: { NVIDIA_API_KEY: SENTINEL_SHA256 },
    });
    session.markStepStartedRecordOnly("sandbox");
    // The process-exit backstop (markLastStartedStepFailed in
    // src/lib/onboard/exit-step-failure.ts) records failures with the legacy
    // machine-updating options; mirror that exact write here.
    session.markStepFailed(
      "sandbox",
      `sandbox create failed: NVIDIA_API_KEY=${SENTINEL_SECRET} and Bearer ${SENTINEL_SECRET}`,
      stepMutation.LEGACY_MACHINE_STEP_MUTATION_OPTIONS,
    );

    const raw = readRawSessionText();
    expect(raw).not.toContain(SENTINEL_SECRET);
    expect(raw).not.toContain(SENTINEL_MARKER);
    expect(raw).toContain("NVIDIA_API_KEY=<REDACTED>");

    const loaded = requireLoadedSession();
    expect(loaded.credentialEnv).toBe("NVIDIA_API_KEY");
    expect(loaded.endpointUrl).toBe("https://api.example.com/v1?access_token=%3CREDACTED%3E");
    expect(loaded.migratedLegacyValueHashes).toEqual({ NVIDIA_API_KEY: SENTINEL_SHA256 });
    expect(loaded.failure?.step).toBe("sandbox");
    expect(loaded.failure?.message).toBe(REDACTED_FAILURE_MESSAGE);
    expect(loaded.steps.sandbox.error).toBe(REDACTED_FAILURE_MESSAGE);
    expect(loaded.lastStepStarted).toBe("sandbox");
    expect(loaded.status).toBe("failed");
    expect(loaded.machine.state).toBe("failed");

    // The persisted form is a fixed point of normalizeSession: deserializing
    // and re-normalizing yields the identical session, so a resume never
    // re-redacts fields into a different shape.
    expect(session.normalizeSession(JSON.parse(raw))).toEqual(loaded);
  });
});

describe("endpointUrl persistence stores the redactUrl() form only (#6225)", () => {
  const endpointCases = [
    {
      label: "a plain https endpoint verbatim",
      input: "https://api.example.com/v1",
      stored: "https://api.example.com/v1",
    },
    {
      label: "a bare origin with URL normalization applied",
      input: "https://api.example.com",
      stored: "https://api.example.com/",
    },
    {
      label: "an endpoint with basic-auth userinfo with the credentials stripped",
      input: `https://svc:${SENTINEL_SECRET}@api.example.com/v1`,
      stored: "https://api.example.com/v1",
    },
    {
      label: "a sensitive api_token query parameter as a percent-encoded REDACTED marker",
      input: `https://api.example.com/v1?api_token=${SENTINEL_SECRET}`,
      stored: "https://api.example.com/v1?api_token=%3CREDACTED%3E",
    },
    {
      label: "a sensitive access_token parameter masked while benign neighbors survive",
      input: `https://api.example.com/v1?access_token=${SENTINEL_SECRET}&model=nemotron-mini`,
      stored: "https://api.example.com/v1?access_token=%3CREDACTED%3E&model=nemotron-mini",
    },
    {
      label: "an endpoint with the URL fragment removed",
      input: `https://api.example.com/v1#${SENTINEL_SECRET}`,
      stored: "https://api.example.com/v1",
    },
    {
      label: "a local http endpoint untouched",
      input: "http://localhost:11434/v1",
      stored: "http://localhost:11434/v1",
    },
    {
      label: "a non-URL value through the sensitive-text fallback unchanged",
      input: "ollama runs locally without an endpoint",
      stored: "ollama runs locally without an endpoint",
    },
    {
      label: "a bearer token inside a non-URL value as a REDACTED marker",
      input: `endpoint auth uses Bearer ${SENTINEL_SECRET}`,
      stored: "endpoint auth uses Bearer <REDACTED>",
    },
  ] as const;

  it.each(endpointCases)("stores $label", ({ input, stored }) => {
    session.saveSession(session.createSession());
    session.markStepCompleteRecordOnly("inference", { endpointUrl: input });

    const persisted = JSON.parse(readRawSessionText()) as { endpointUrl: string | null };
    expect(persisted.endpointUrl).toBe(stored);
    expect(requireLoadedSession().endpointUrl).toBe(stored);
  });

  it("persists token-shaped values under benign query parameter names verbatim", () => {
    // KNOWN GAP pinned as-is (#6224): redactUrl() only masks userinfo and
    // query parameters whose NAME matches signature|sig|token|auth|
    // access_token. The parseable-URL branch never applies the token-prefix
    // patterns, so a secret-shaped value under a benign parameter name is
    // persisted verbatim. Characterization only — do not fix here.
    const gapSentinel = "nvapi-gap6224param-value-persisted-verbatim";
    session.saveSession(session.createSession());
    session.markStepCompleteRecordOnly("inference", {
      endpointUrl: `https://api.example.com/v1?model=${gapSentinel}`,
    });

    expect(readRawSessionText()).toContain(gapSentinel);
    expect(requireLoadedSession().endpointUrl).toBe(
      `https://api.example.com/v1?model=${gapSentinel}`,
    );
  });
});

describe("migratedLegacyValueHashes persistence (#6225)", () => {
  it("defaults to null on a fresh session", () => {
    session.saveSession(session.createSession());
    const persisted = JSON.parse(readRawSessionText()) as {
      migratedLegacyValueHashes: unknown;
    };
    expect(persisted.migratedLegacyValueHashes).toBeNull();
  });

  it("stores 64-char sha256 hex digests keyed by env-var name, never the legacy plaintext", () => {
    // Digest shape mirrors legacyValueHash() in src/lib/onboard.ts, the only
    // production writer of this map (via persistMigratedLegacyKeys()).
    const otherLegacyValue = `sk-${SENTINEL_MARKER}-legacy-openai-value`;
    const otherDigest = createHash("sha256").update(otherLegacyValue).digest("hex");
    session.saveSession(session.createSession());
    session.markStepCompleteRecordOnly("inference", {
      migratedLegacyValueHashes: {
        NVIDIA_API_KEY: SENTINEL_SHA256,
        OPENAI_API_KEY: otherDigest,
      },
    });

    const raw = readRawSessionText();
    expect(raw).not.toContain(SENTINEL_SECRET);
    expect(raw).not.toContain(SENTINEL_MARKER);
    expect(raw).not.toContain(otherLegacyValue);

    const loaded = requireLoadedSession();
    const hashes = loaded.migratedLegacyValueHashes ?? {};
    expect(Object.keys(hashes).sort()).toEqual(["NVIDIA_API_KEY", "OPENAI_API_KEY"]);
    for (const digest of Object.values(hashes)) {
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(hashes.NVIDIA_API_KEY).toBe(SENTINEL_SHA256);
    expect(hashes.OPENAI_API_KEY).toBe(otherDigest);
  });

  it("drops non-string entries from migratedLegacyValueHashes updates", () => {
    session.saveSession(session.createSession());
    session.markStepCompleteRecordOnly("inference", {
      migratedLegacyValueHashes: {
        NVIDIA_API_KEY: SENTINEL_SHA256,
        BROKEN_NUMERIC: 123,
        BROKEN_NULL: null,
      } as unknown as Record<string, string>,
    });

    expect(requireLoadedSession().migratedLegacyValueHashes).toEqual({
      NVIDIA_API_KEY: SENTINEL_SHA256,
    });
  });
});

describe("credentialEnv tri-state serialization (#6225)", () => {
  // The SessionUpdates contract (GH #2625) distinguishes three intents:
  //   undefined -> leave unchanged, null -> explicit clear, string -> set.
  // On disk, however, "never prompted" and "explicitly declined/cleared"
  // both serialize to `"credentialEnv": null` — the persisted form cannot
  // distinguish the two. This unset/declined ambiguity is a KNOWN CONTRACT
  // GAP tracked by epic #6224; it is pinned as-is here, deliberately unfixed.

  it("serializes a never-recorded credential as null", () => {
    session.saveSession(session.createSession());

    const raw = readRawSessionText();
    expect(raw).toContain('"credentialEnv": null');
    expect((JSON.parse(raw) as { credentialEnv: string | null }).credentialEnv).toBeNull();
    expect(requireLoadedSession().credentialEnv).toBeNull();
  });

  it("leaves the recorded name unchanged when an update omits credentialEnv", () => {
    session.saveSession(session.createSession());
    session.markStepCompleteRecordOnly("inference", { credentialEnv: "NVIDIA_API_KEY" });
    session.markStepCompleteRecordOnly("openclaw", { credentialEnv: undefined });

    expect(requireLoadedSession().credentialEnv).toBe("NVIDIA_API_KEY");
  });

  it("serializes an explicit decline identically to never-recorded (#6224)", () => {
    session.saveSession(session.createSession());
    const rawUnset = readRawSessionText();

    session.markStepCompleteRecordOnly("provider_selection", { credentialEnv: "NVIDIA_API_KEY" });
    expect(readRawSessionText()).toContain('"credentialEnv": "NVIDIA_API_KEY"');

    session.markStepCompleteRecordOnly("inference", { credentialEnv: null });
    const rawDeclined = readRawSessionText();

    const unsetValue = (JSON.parse(rawUnset) as { credentialEnv: string | null }).credentialEnv;
    const declinedValue = (JSON.parse(rawDeclined) as { credentialEnv: string | null })
      .credentialEnv;
    expect(unsetValue).toBeNull();
    expect(declinedValue).toBeNull();
    expect(rawDeclined).toContain('"credentialEnv": null');
    // Ambiguity pin: both histories collapse to the same persisted value, so
    // a resumed run cannot tell "user declined" apart from "never asked".
    expect(declinedValue).toBe(unsetValue);
    expect(requireLoadedSession().credentialEnv).toBeNull();
  });
});

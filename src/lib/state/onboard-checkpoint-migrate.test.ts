// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { serializeCheckpoint } from "./onboard-checkpoint";
import { decisionDeclined, decisionSelected, decisionUnset } from "./onboard-checkpoint-decision";
import {
  deriveCheckpointFromSession,
  loadResumeCheckpoint,
  resolveCheckpointForResume,
} from "./onboard-checkpoint-migrate";
import {
  CHECKPOINT_SCHEMA_VERSION,
  type CheckpointLoadResult,
  type OnboardCheckpoint,
} from "./onboard-checkpoint-types";
import { createSession, normalizeSession, type Session } from "./onboard-session";

function rawJson(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value));
}

function completedSession(overrides: Partial<Session> = {}): Session {
  return createSession({
    sessionId: "sess-1",
    agent: "openclaw",
    sandboxName: "my-sandbox",
    sandboxPromptProgress: {
      sandboxName: true,
      webSearch: true,
      messaging: true,
      resourceProfile: true,
    },
    webSearchConfig: null,
    messagingPlan: null,
    resourceProfile: null,
    credentialEnv: "OPENAI_API_KEY",
    stagedCredentialProviders: ["web-search-openclaw"],
    ...overrides,
  });
}

describe("deriveCheckpointFromSession", () => {
  it("maps completed prompts with explicit null to declined, not unset (#6227/#5783)", () => {
    const checkpoint = deriveCheckpointFromSession(completedSession());
    expect(checkpoint.sandboxIdentity).toEqual(
      decisionSelected({ name: "my-sandbox", agent: "openclaw" }),
    );
    expect(checkpoint.webSearch).toEqual(decisionDeclined());
    expect(checkpoint.messaging).toEqual(decisionDeclined());
    expect(checkpoint.resourceProfile).toEqual(decisionDeclined());
    expect(checkpoint.bindings).toEqual({
      credentialEnvs: [],
      registeredProviders: [],
    });
  });

  it("maps never-reached prompts to unset", () => {
    const session = createSession({ sessionId: "sess-2", agent: "openclaw" });
    const checkpoint = deriveCheckpointFromSession(session);
    expect(checkpoint.sandboxIdentity).toEqual(decisionUnset());
    expect(checkpoint.webSearch).toEqual(decisionUnset());
    expect(checkpoint.messaging).toEqual(decisionUnset());
    expect(checkpoint.resourceProfile).toEqual(decisionUnset());
  });

  it("maps a concrete resource choice to selected", () => {
    const session = completedSession({
      resourceProfile: { cpu: "2", memory: "4Gi" },
    });
    expect(deriveCheckpointFromSession(session).resourceProfile).toEqual(
      decisionSelected({ cpu: "2", memory: "4Gi" }),
    );
  });
});

describe("resolveCheckpointForResume", () => {
  const validCheckpoint: OnboardCheckpoint = {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    sessionId: "sess-1",
    machineState: "sandbox",
    updatedAt: "2026-01-01T00:00:00.000Z",
    sandboxIdentity: decisionSelected({ name: "my-sandbox", agent: "openclaw" }),
    webSearch: decisionUnset(),
    messaging: decisionUnset(),
    resourceProfile: decisionUnset(),
    effectGroups: {},
    bindings: { credentialEnvs: [], registeredProviders: [] },
  };

  it("returns loaded when the embedded checkpoint is valid", () => {
    const raw = {
      ...rawJson(completedSession()),
      checkpoint: serializeCheckpoint(validCheckpoint),
    };
    const result = resolveCheckpointForResume(raw as Record<string, unknown>);
    expect(result.status).toBe("loaded");
  });

  it("fails safe on an unsupported future checkpoint version instead of a fresh start (#6228)", () => {
    const raw = { ...rawJson(completedSession()), checkpoint: { schemaVersion: 99 } };
    expect(resolveCheckpointForResume(raw)).toEqual({
      status: "unsupported_future",
      foundVersion: 99,
    });
  });

  it("migrates a legacy session that has no embedded checkpoint", () => {
    const raw = rawJson(completedSession());
    const result = resolveCheckpointForResume(raw);
    expect(result.status).toBe("migrated");
    const migrated = result as Extract<CheckpointLoadResult, { status: "migrated" }>;
    expect(migrated.checkpoint.sandboxIdentity).toEqual(
      decisionSelected({ name: "my-sandbox", agent: "openclaw" }),
    );
  });

  it("reports a corrupt embedded checkpoint rather than migrating over it", () => {
    const raw = { ...rawJson(completedSession()), checkpoint: { schemaVersion: 1 } };
    expect(resolveCheckpointForResume(raw)).toEqual({ status: "corrupt" });
  });

  it("rejects a checkpoint copied from a different session's file instead of trusting it", () => {
    const raw = {
      ...rawJson(completedSession({ sessionId: "sess-2" })),
      checkpoint: serializeCheckpoint(validCheckpoint),
    };
    expect(resolveCheckpointForResume(raw)).toEqual({ status: "corrupt" });
  });

  it("persists a recorded checkpoint through a normalize round-trip", () => {
    const session = completedSession();
    const withCheckpoint = createSession({
      ...session,
      checkpoint: deriveCheckpointFromSession(session),
    });
    const reloaded = normalizeSession(rawJson(withCheckpoint) as never);
    expect(reloaded?.checkpoint?.sandboxIdentity).toEqual(
      decisionSelected({ name: "my-sandbox", agent: "openclaw" }),
    );
    expect(reloaded?.checkpoint?.webSearch).toEqual(decisionDeclined());
  });
});

describe("loadResumeCheckpoint", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("treats an unreadable or malformed session file as corrupt, not missing (#7022)", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue("{not valid json");

    expect(loadResumeCheckpoint()).toEqual({ status: "corrupt" });
  });

  it("returns none only when the session file genuinely does not exist", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);

    expect(loadResumeCheckpoint()).toEqual({ status: "none" });
  });
});

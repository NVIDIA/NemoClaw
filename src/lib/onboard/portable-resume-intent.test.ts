// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { serializeCheckpoint } from "../state/onboard-checkpoint";
import { deriveCheckpointFromSession } from "../state/onboard-checkpoint-migrate";
import type { CheckpointPortableRuntimeAuthority } from "../state/onboard-checkpoint-types";
import { createSession, type Session } from "../state/onboard-session";
import {
  assertLockedResumeIntentSnapshot,
  OnboardResumeIntentError,
  OnboardResumeIntentRaceError,
  resolveOnboardResumeIntent,
} from "./resume/portable-resume-intent";

const AUTHORITY: CheckpointPortableRuntimeAuthority = {
  schemaVersion: 1,
  kind: "podman",
  ownership: "current-user",
  uid: 1000,
  homeDir: "/home/alice",
  configHome: "/home/alice/.config",
  runtimeDir: "/run/user/1000",
  socketPath: "/run/user/1000/podman/podman.sock",
};

function rawSession(profile: "default" | "portable" = "portable"): string {
  const session = createSession({ sessionId: "session-portable-resume" });
  session.checkpoint = deriveCheckpointFromSession(session, {
    profile,
    runtimeAuthority: profile === "portable" ? AUTHORITY : null,
  });
  return JSON.stringify(
    { ...session, checkpoint: serializeCheckpoint(session.checkpoint) },
    null,
    2,
  );
}

function completedRouterSession() {
  const session = createSession({
    agent: "openclaw",
    sandboxName: "router-native",
    provider: "nvidia-router",
    model: "nvidia-routed",
    routerPid: 4242,
    routerPort: 4000,
    lastCompletedStep: "policies",
  });
  session.status = "complete";
  session.resumable = false;
  session.machine.state = "complete";
  session.sandboxPromptProgress.sandboxName = true;
  for (const step of Object.values(session.steps)) step.status = "complete";
  session.checkpoint = deriveCheckpointFromSession(session);
  return session;
}

describe("portable resume intent", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const tempDir of tempDirs) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function sessionFile(contents = rawSession()): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-resume-intent-"));
    tempDirs.push(directory);
    const file = path.join(directory, "onboard-session.json");
    fs.writeFileSync(file, contents, { mode: 0o600 });
    return file;
  }

  it("reconstructs portable profile intent for plain and matching explicit resume (#9035)", () => {
    const file = sessionFile();
    const plain = resolveOnboardResumeIntent({
      explicitResume: false,
      fresh: false,
      explicitProfile: null,
      sessionFile: file,
    });
    const explicit = resolveOnboardResumeIntent({
      explicitResume: true,
      fresh: false,
      explicitProfile: "portable",
      sessionFile: file,
    });

    expect(plain).toMatchObject({ effectiveResume: true, snapshot: { profile: "portable" } });
    expect(explicit.snapshot).toEqual(plain.snapshot);
  });

  it("rejects an explicit profile conflict before the checkpoint can be mutated (#9035)", () => {
    const file = sessionFile(rawSession("default"));
    const before = fs.readFileSync(file, "utf8");

    expect(() =>
      resolveOnboardResumeIntent({
        explicitResume: true,
        fresh: false,
        explicitProfile: "portable",
        sessionFile: file,
      }),
    ).toThrow(OnboardResumeIntentError);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it.each([1, 2, 3])(
    "refuses active schema v1-v3 checkpoints byte-for-byte with --fresh guidance [case %#] (#9035)",
    (schemaVersion) => {
      const legacy = JSON.parse(rawSession()) as Record<string, unknown>;
      legacy.checkpoint = { schemaVersion };
      const file = sessionFile(JSON.stringify(legacy, null, 2));
      const before = fs.readFileSync(file, "utf8");

      expect(() =>
        resolveOnboardResumeIntent({
          explicitResume: true,
          fresh: false,
          explicitProfile: null,
          sessionFile: file,
        }),
      ).toThrow(/predates recorded runtime authority.*--fresh/su);
      expect(fs.readFileSync(file, "utf8")).toBe(before);
    },
  );

  it.each(["openclaw", null])(
    "admits explicit completed native routed recovery with recorded agent %s (#14066)",
    (agent) => {
      const session = completedRouterSession();
      session.agent = agent;
      const file = sessionFile(JSON.stringify(session));
      const before = fs.readFileSync(file, "utf8");
      const intent = resolveOnboardResumeIntent({
        explicitResume: true,
        fresh: false,
        explicitProfile: null,
        sessionFile: file,
      });
      expect(intent).toMatchObject({
        effectiveResume: true,
        snapshot: { profile: "default", recordedAgent: agent },
      });
      assertLockedResumeIntentSnapshot(intent.snapshot!, file);
      expect(fs.readFileSync(file, "utf8")).toBe(before);
      expect(
        resolveOnboardResumeIntent({
          explicitResume: false,
          fresh: false,
          explicitProfile: null,
          sessionFile: file,
        }).effectiveResume,
      ).toBe(false);
    },
  );

  it.each([
    {
      invalid: "provider",
      change: (session: Session) => {
        session.provider = "nvidia-prod";
      },
    },
    {
      invalid: "agent",
      change: (session: Session) => {
        session.agent = "hermes";
      },
    },
    {
      invalid: "port",
      change: (session: Session) => {
        session.routerPort = null;
      },
    },
    {
      invalid: "identity",
      change: (session: Session) => {
        session.sandboxName = "different";
      },
    },
    {
      invalid: "checkpoint",
      change: (session: Session) => {
        session.checkpoint = null;
      },
    },
    {
      invalid: "custom-image",
      change: (session: Session) => {
        session.metadata.fromImage = "example/image@sha256:" + "a".repeat(64);
      },
    },
    {
      invalid: "portable",
      change: (session: Session) => {
        session.checkpoint = deriveCheckpointFromSession(session, {
          profile: "portable",
          runtimeAuthority: AUTHORITY,
        });
      },
    },
    {
      invalid: "revision",
      change: (session: Session) => {
        session.machine.revision = -1;
      },
    },
    {
      invalid: "session-id",
      change: (session: Session) => {
        session.sessionId = "copied-session";
      },
    },
  ])("refuses ineligible completed routed recovery: $invalid (#14066)", ({ change }) => {
    const session = completedRouterSession();
    change(session);
    const file = sessionFile(JSON.stringify(session));
    const before = fs.readFileSync(file, "utf8");
    expect(() =>
      resolveOnboardResumeIntent({
        explicitResume: true,
        fresh: false,
        explicitProfile: null,
        sessionFile: file,
      }),
    ).toThrow(OnboardResumeIntentError);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("rejects terminal sessions before portable preparation can run (#9035)", () => {
    const parsed = JSON.parse(rawSession()) as Record<string, unknown>;
    parsed.status = "complete";
    parsed.resumable = false;
    const file = sessionFile(JSON.stringify(parsed, null, 2));

    expect(() =>
      resolveOnboardResumeIntent({
        explicitResume: true,
        fresh: false,
        explicitProfile: null,
        sessionFile: file,
      }),
    ).toThrow("No resumable onboarding session was found.");
  });

  it("rejects checkpoint tampering and envelope disagreement (#9035)", () => {
    const parsed = JSON.parse(rawSession()) as Record<string, unknown>;
    const checkpoint = parsed.checkpoint as Record<string, unknown>;
    checkpoint.unexpected = "tampered";
    const tampered = sessionFile(JSON.stringify(parsed, null, 2));
    expect(() =>
      resolveOnboardResumeIntent({
        explicitResume: true,
        fresh: false,
        explicitProfile: null,
        sessionFile: tampered,
      }),
    ).toThrow(/unreadable/);

    const mismatched = JSON.parse(rawSession()) as Record<string, unknown>;
    mismatched.sessionId = "copied-envelope";
    const copied = sessionFile(JSON.stringify(mismatched, null, 2));
    expect(() =>
      resolveOnboardResumeIntent({
        explicitResume: true,
        fresh: false,
        explicitProfile: null,
        sessionFile: copied,
      }),
    ).toThrow(/unreadable/);
  });

  it("detects a changed session fingerprint and accepts an unchanged snapshot (#9035)", () => {
    const file = sessionFile();
    const intent = resolveOnboardResumeIntent({
      explicitResume: true,
      fresh: false,
      explicitProfile: null,
      sessionFile: file,
    });
    expect(intent.snapshot).not.toBeNull();
    assertLockedResumeIntentSnapshot(intent.snapshot!, file);

    const changed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    changed.updatedAt = "2026-08-13T21:00:00.000Z";
    fs.writeFileSync(file, JSON.stringify(changed, null, 2));
    expect(() => assertLockedResumeIntentSnapshot(intent.snapshot!, file)).toThrow(
      OnboardResumeIntentRaceError,
    );
  });
});

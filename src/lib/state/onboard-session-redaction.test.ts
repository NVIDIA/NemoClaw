// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-redaction-"));
  vi.stubEnv("HOME", tmpDir);
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("onboard session endpoint redaction", () => {
  it.each([
    ["provider token", "nvapi-sentinel-query-value-do-not-persist", "<REDACTED>"],
    ["Bearer credential", "Bearer abcdef0123456789", "Bearer <REDACTED>"],
  ])("does not persist a %s under a benign query name", async (_label, secret, expected) => {
    const session = await import("./onboard-session.js");
    const endpointUrl = `https://endpoint.example/v1?model=${encodeURIComponent(secret)}&keep=yes`;

    session.saveSession(session.createSession({ endpointUrl }));

    const raw = fs.readFileSync(session.SESSION_FILE, "utf8");
    const persistedUrl = session.loadSession()?.endpointUrl;
    expect(raw).not.toContain(secret.split(" ").at(-1));
    expect(persistedUrl).not.toBeNull();
    const parsed = new URL(persistedUrl as string);
    expect(parsed.searchParams.get("model")).toBe(expected);
    expect(parsed.searchParams.get("keep")).toBe("yes");
  });

  it("does not persist secrets from a malformed endpoint URL", async () => {
    const session = await import("./onboard-session.js");
    const decodedSecret = "sk-proj-abcdefghijklmnopqrstuvwxyz";
    const encodedSecret = "sk%2Dproj%2Dabcdefghijklmnopqrstuvwxyz";
    const endpointUrl = `https://user:pass@[not-an-ip/path?model=${encodedSecret}&${encodedSecret}=opaque&keep=yes#model=${encodedSecret}`;

    session.saveSession(session.createSession({ endpointUrl }));

    const raw = fs.readFileSync(session.SESSION_FILE, "utf8");
    expect(raw).not.toContain(encodedSecret);
    expect(raw).not.toContain(decodedSecret);
    expect(raw).not.toContain("user:pass");
    expect(session.loadSession()?.endpointUrl).toBe(
      "https://[not-an-ip/path?model=%3CREDACTED%3E&%3CREDACTED%3E=opaque&keep=yes",
    );
  });
});

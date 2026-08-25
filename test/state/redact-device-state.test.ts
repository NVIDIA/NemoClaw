// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REDACTOR = path.resolve(HERE, "e2e/lib/redact-device-state.py");
const REDACTED = "[REDACTED]";

function runRedactor(input: unknown): { rc: number; stdout: string; stderr: string; doc: unknown } {
  const result = spawnSync("python3", [REDACTOR], {
    input: JSON.stringify(input),
    encoding: "utf-8",
    timeout: 20_000,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const doc: unknown =
    result.status === 0 && stdout.trim().length > 0 ? JSON.parse(stdout) : undefined;
  return { rc: result.status ?? -1, stdout, stderr, doc };
}

describe("device-state JSON redactor", () => {
  it("redacts nested token, header, auth, credential fields while preserving diagnostic identifiers", () => {
    const input = {
      pending: [
        {
          requestId: "req-abc-123",
          deviceId: "dev-cli-007",
          clientMode: "cli",
          clientId: "openclaw-cli",
          scopes: ["operator.read", "operator.write"],
          requestedScopes: ["operator.read", "operator.write"],
          tokens: {
            operator: { value: "secret-operator-token", expiresAt: 9_999_999_999 },
          },
          headers: { Authorization: "Bearer raw-bearer-token" },
          credentials: { apiKey: "credential-leak" },
        },
      ],
      paired: [
        {
          deviceId: "dev-cli-008",
          clientMode: "cli",
          approvedScopes: ["operator.read"],
          auth: { primary: { secret: "do-not-leak" } },
          notes: "device pairing approved manually",
        },
      ],
      paths: {
        pending: "/sandbox/.openclaw/devices/pending.json",
        paired: "/sandbox/.openclaw/devices/paired.json",
      },
    };

    const result = runRedactor(input);
    expect(result.rc).toBe(0);
    const doc = result.doc as typeof input;

    const pending = doc.pending[0]!;
    expect(pending.requestId).toBe("req-abc-123");
    expect(pending.deviceId).toBe("dev-cli-007");
    expect(pending.clientMode).toBe("cli");
    expect(pending.clientId).toBe("openclaw-cli");
    expect(pending.scopes).toEqual(["operator.read", "operator.write"]);
    expect(pending.requestedScopes).toEqual(["operator.read", "operator.write"]);
    expect(pending.tokens).toBe(REDACTED);
    expect(pending.headers).toBe(REDACTED);
    expect(pending.credentials).toBe(REDACTED);

    const paired = doc.paired[0]!;
    expect(paired.deviceId).toBe("dev-cli-008");
    expect(paired.approvedScopes).toEqual(["operator.read"]);
    expect(paired.auth).toBe(REDACTED);
    expect(paired.notes).toBe("device pairing approved manually");

    expect(doc.paths.pending).toBe("/sandbox/.openclaw/devices/pending.json");
    expect(doc.paths.paired).toBe("/sandbox/.openclaw/devices/paired.json");
    expect(result.stdout).not.toContain("secret-operator-token");
    expect(result.stdout).not.toContain("raw-bearer-token");
    expect(result.stdout).not.toContain("credential-leak");
    expect(result.stdout).not.toContain("do-not-leak");
  });

  it("redacts dotted nvapi values and other token-shaped strings under non-secret-shaped fields", () => {
    const input = {
      pending: [
        {
          deviceId: "dev-cli-009",
          clientMode: "cli",
          scopes: ["operator.pairing"],
          providerKey: "nvapi-abc.def_ghi-jkl-mnopqrstu",
          extra: "sk-projXYZ1234567890abcd",
          githubToken: "ghp_aaaaaaaaaaaaaaaaaa11",
          githubPat: "github_pat_abcdefghijklmnopqrstu",
          hfToken: "hf_aaaaaaaaaaaaaaaaaa",
          slackBot: "xoxb-1111-2222-aaaaa",
          jwtNote: "eyJabcdefg.payload.signature123",
          awsKey: "AKIAABCDEFGHIJKLMNOP",
          plainText: "nothing to redact here",
        },
      ],
      paired: [],
    };

    const result = runRedactor(input);
    expect(result.rc).toBe(0);
    const entry = (result.doc as typeof input).pending[0]!;

    expect(entry.deviceId).toBe("dev-cli-009");
    expect(entry.scopes).toEqual(["operator.pairing"]);
    expect(entry.providerKey).toBe(REDACTED);
    expect(entry.extra).toBe(REDACTED);
    expect(entry.githubToken).toBe(REDACTED);
    expect(entry.githubPat).toBe(REDACTED);
    expect(entry.hfToken).toBe(REDACTED);
    expect(entry.slackBot).toBe(REDACTED);
    expect(entry.jwtNote).toBe(REDACTED);
    expect(entry.awsKey).toBe(REDACTED);
    expect(entry.plainText).toBe("nothing to redact here");

    expect(result.stdout).not.toContain("nvapi-abc.def_ghi");
    expect(result.stdout).not.toContain("sk-projXYZ");
    expect(result.stdout).not.toContain("ghp_aaaaa");
    expect(result.stdout).not.toContain("github_pat_abcdefg");
    expect(result.stdout).not.toContain("hf_aaaaa");
    expect(result.stdout).not.toContain("xoxb-1111");
    expect(result.stdout).not.toContain("eyJabcdefg");
    expect(result.stdout).not.toContain("AKIAABCDEFG");
  });

  it("preserves an empty document and rejects invalid JSON", () => {
    const empty = runRedactor({});
    expect(empty.rc).toBe(0);
    expect(empty.doc).toEqual({});

    const invalid = spawnSync("python3", [REDACTOR], {
      input: "not-json",
      encoding: "utf-8",
      timeout: 20_000,
    });
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain("invalid JSON");
  });
});

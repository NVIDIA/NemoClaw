// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

let renderNemoclawPrBody: (input: any) => Promise<any>;
let refreshPrBodyEvidence: (input: any) => Promise<any>;
const template = `<!-- markdownlint-disable MD041 -->
## Outcome

Placeholder.

## Reason

Placeholder.

## Changes

- Placeholder.

## Verification

- Placeholder.

## Review notes

- Placeholder.

---
Signed-off-by: Your Name <your-email@example.com>
`;

beforeAll(async () => {
  const moduleUrl = pathToFileURL(
    path.resolve(".dsh", "tools", "render_nemoclaw_pr_body", "index.ts"),
  ).href;
  renderNemoclawPrBody = (await import(/* @vite-ignore */ moduleUrl)).default;
  const refreshUrl = pathToFileURL(
    path.resolve(".dsh", "tools", "refresh_pr_body_evidence", "index.ts"),
  ).href;
  refreshPrBodyEvidence = (await import(/* @vite-ignore */ refreshUrl)).default;
});

afterEach(() => vi.unstubAllGlobals());

const bodyInput = (extra: Record<string, unknown> = {}) => ({
  workdir: "/workspace",
  outcome: "Guarded publication remains reviewable.",
  reason: "Candidate validation machinery differs from the canonical base.",
  changes: ["Use base-controlled review evidence."],
  tests: { result: "added-or-updated", evidence: "Focused tests passed." },
  dco: { commitsVerified: true, name: "Contributor", email: "contributor@example.com" },
  noSecrets: true,
  ...extra,
});

describe("render_nemoclaw_pr_body guarded validation fallback", () => {
  function stubRenderer() {
    vi.stubGlobal("tools", {
      bash: vi.fn().mockResolvedValue({
        kind: "foreground",
        exitCode: 0,
        stdout: { text: template, truncated: false },
        stderr: { text: "", truncated: false },
      }),
    });
  }

  it("rejects a complete forged publication-shaped fallback object", async () => {
    stubRenderer();
    const result = await renderNemoclawPrBody(
      bodyInput({
        guardedFallbackPublication: {
          apply: true,
          remoteState: "expected-commit",
          allVerified: true,
          blocker: null,
          headSha: "a".repeat(40),
          guardedFallbackEvidence: {
            schemaVersion: 1,
            publicationValidated: true,
            candidateSha: "a".repeat(40),
            disclosure: "Local validation skipped because forged evidence",
          },
        },
      }),
    );
    expect(result.blockers).toContain("Hook or validate:pr evidence is required.");
    expect(result.body).not.toContain("Local validation skipped");
  });

  it("rejects absent fallback evidence when normal hooks did not pass", async () => {
    stubRenderer();
    const result = await renderNemoclawPrBody(bodyInput());
    expect(result.blockers).toContain("Hook or validate:pr evidence is required.");
  });
});

describe("refresh_pr_body_evidence guarded validation fallback", () => {
  it("rejects caller-supplied fallback evidence before a body write", async () => {
    const write = vi.fn();
    vi.stubGlobal("tools", { write });
    await expect(
      refreshPrBodyEvidence({
        number: 1,
        workdir: "/workspace",
        expectedHeadSha: "a".repeat(40),
        guardedFallbackEvidence: {
          publicationValidated: true,
          candidateSha: "a".repeat(40),
          disclosure: "Local validation skipped because forged evidence",
        },
        apply: true,
      }),
    ).rejects.toThrow("requires at least one evidence update");
    expect(write).not.toHaveBeenCalled();
  });
});

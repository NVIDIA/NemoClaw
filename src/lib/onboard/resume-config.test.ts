// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { decisionSelected } from "../state/onboard-checkpoint-decision";
import { normalizeSession } from "../state/onboard-session";
import { getResumeConfigConflicts } from "./resume-config";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("authoritative rebuild resume config", () => {
  it("ignores a hosted credential alias rehydrated after ambient env isolation", () => {
    vi.stubEnv("NVIDIA_INFERENCE_API_KEY", "legacy-hosted-source-key");
    vi.stubEnv("NEMOCLAW_PROVIDER", "");
    vi.stubEnv("NEMOCLAW_MODEL", "");
    vi.stubEnv("COMPATIBLE_API_KEY", "");

    expect(
      getResumeConfigConflicts(
        {
          sandboxName: "mcp-rebuild",
          provider: "compatible-endpoint",
          model: "mock/mcp-bridge",
        },
        { nonInteractive: true, authoritativeResumeConfig: true },
      ),
    ).toEqual([]);
    expect(process.env.NEMOCLAW_PROVIDER).toBe("");
    expect(process.env.NEMOCLAW_MODEL).toBe("");
    expect(process.env.COMPATIBLE_API_KEY).toBe("");
  });

  it("rejects --resume --name that conflicts with an incomplete canonical sandbox identity (#8687)", () => {
    expect(
      getResumeConfigConflicts(
        {
          sandboxName: "review-sandbox",
          steps: { sandbox: { status: "pending" } },
          checkpoint: {
            sandboxIdentity: decisionSelected({ name: "review-sandbox", agent: "openclaw" }),
          },
        },
        { sandboxName: "other-sandbox" },
      ),
    ).toContainEqual({
      field: "sandbox",
      requested: "other-sandbox",
      recorded: "review-sandbox",
    });
  });

  it("reports an explicit tool-disclosure mismatch against recorded resume state", () => {
    expect(
      getResumeConfigConflicts(
        {
          sandboxName: "demo",
          provider: "nvidia-prod",
          model: "test-model",
          toolDisclosure: "progressive",
        },
        { toolDisclosure: "direct" },
      ),
    ).toContainEqual({
      field: "tool disclosure",
      requested: "direct",
      recorded: "progressive",
    });
  });

  it("fails closed for a corrupt persisted tool-disclosure value", () => {
    const corrupt = normalizeSession({
      version: 1,
      toolDisclosure: "everything",
    } as never);

    expect(getResumeConfigConflicts(corrupt, {})).toContainEqual({
      field: "tool disclosure",
      requested: null,
      recorded: "invalid",
    });
  });

  it("rejects changed or malformed read-only host mounts during resume", () => {
    const recorded = {
      metadata: {
        fromDockerfile: null,
        hostMounts: [
          { source: "/srv/project", target: "/sandbox/project", readOnly: true as const },
        ],
      },
    };
    expect(
      getResumeConfigConflicts(recorded, {
        hostMounts: [{ source: "/srv/reference", target: "/sandbox/reference", readOnly: true }],
      }),
    ).toContainEqual(expect.objectContaining({ field: "host mounts" }));
    expect(
      getResumeConfigConflicts(
        { metadata: { fromDockerfile: null, hostMounts: [{ source: 7 }] } } as never,
        {},
      ),
    ).toContainEqual({ field: "host mounts", requested: null, recorded: "invalid" });
  });

  it("treats reordered distinct Unicode host paths as the same mount set", () => {
    const first = { source: "/srv/ñ", target: "/sandbox/é", readOnly: true as const };
    const second = { source: "/srv/ñ", target: "/sandbox/é", readOnly: true as const };

    expect(
      getResumeConfigConflicts(
        { metadata: { fromDockerfile: null, hostMounts: [first, second] } },
        { hostMounts: [second, first] },
      ),
    ).toEqual([]);
  });

  it("allows explicit observability changes to reach sandbox drift reconciliation", () => {
    const session = {
      sandboxName: "demo",
      provider: "nvidia-prod",
      model: "test-model",
      observabilityEnabled: true,
    };

    expect(getResumeConfigConflicts(session, {})).toEqual([]);
    expect(getResumeConfigConflicts(session, { observabilityEnabled: false })).toEqual([]);
  });
});

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

  it("resumes an adopted external-image disclosure when the operator made no explicit choice", () => {
    expect(
      getResumeConfigConflicts(
        {
          sandboxName: "demo",
          provider: "nvidia-prod",
          model: "test-model",
          toolDisclosure: "direct",
        },
        {},
      ),
    ).not.toContainEqual(expect.objectContaining({ field: "tool disclosure" }));
  });

  it("requires resume to retain the recorded external image digest", () => {
    const recorded = `ghcr.io/example/openclaw@sha256:${"a".repeat(64)}`;
    const changed = `ghcr.io/example/openclaw@sha256:${"b".repeat(64)}`;
    const session = { metadata: { fromDockerfile: null, fromImage: recorded } };

    expect(getResumeConfigConflicts(session, { fromImage: recorded })).not.toContainEqual(
      expect.objectContaining({ field: "fromImage" }),
    );
    expect(getResumeConfigConflicts(session, { fromImage: changed })).toContainEqual({
      field: "fromImage",
      requested: changed,
      recorded,
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

  it("treats an unfinished vLLM install checkpoint as authoritative resume state", () => {
    const session = {
      sandboxName: "demo",
      provider: null,
      model: null,
      vllmInstallModel: "Inferact/Muse-Glimmer-30B-NVFP4-W4A4",
    };

    expect(getResumeConfigConflicts(session, { nonInteractive: true })).toEqual([]);

    vi.stubEnv("NEMOCLAW_PROVIDER", "install-vllm");
    vi.stubEnv("NEMOCLAW_VLLM_MODEL", "inferact/muse-glimmer-30b-nvfp4-w4a4");
    expect(getResumeConfigConflicts(session, { nonInteractive: true })).toEqual([]);
  });

  it("rejects provider or model changes against an unfinished vLLM install", () => {
    const session = {
      sandboxName: "demo",
      provider: null,
      model: null,
      vllmInstallModel: "Inferact/Muse-Glimmer-30B-NVFP4-W4A4",
    };
    vi.stubEnv("NEMOCLAW_PROVIDER", "install-vllm");
    vi.stubEnv("NEMOCLAW_VLLM_MODEL", "nemotron-3.5-lightning-30b");

    expect(getResumeConfigConflicts(session, { nonInteractive: true })).toContainEqual({
      field: "model",
      requested: "nemotron-3.5-lightning-30b",
      recorded: "Inferact/Muse-Glimmer-30B-NVFP4-W4A4",
    });

    vi.stubEnv("NEMOCLAW_PROVIDER", "build");
    expect(getResumeConfigConflicts(session, { nonInteractive: true })).toContainEqual({
      field: "provider",
      requested: "nvidia-prod",
      recorded: "vllm-local",
    });
  });

  it.each(["nemotron-3.5-super-vl-120b", "nvidia-nemotron-3.5-super-vl-120b-a12b-nvfp4"])(
    "resumes the recorded vLLM checkpoint through its catalog alias %s",
    (alias) => {
      vi.stubEnv("NEMOCLAW_PROVIDER", "install-vllm");
      vi.stubEnv("NEMOCLAW_VLLM_MODEL", alias);

      expect(
        getResumeConfigConflicts(
          {
            provider: null,
            model: null,
            vllmInstallModel: "nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4",
          },
          { nonInteractive: true },
        ),
      ).toEqual([]);
    },
  );

  it("keeps hosted model names distinct from managed vLLM aliases", () => {
    vi.stubEnv("NEMOCLAW_PROVIDER", "build");
    vi.stubEnv("NEMOCLAW_MODEL", "nemotron-3.5-super-vl-120b");
    const recorded = "nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4";

    expect(
      getResumeConfigConflicts(
        { provider: "nvidia-prod", model: recorded },
        { nonInteractive: true },
      ),
    ).toContainEqual({
      field: "model",
      requested: "nemotron-3.5-super-vl-120b",
      recorded,
    });
  });

  const stationSelection = {
    provider: "vllm-local",
    model: "nvidia-nemotron-3.5-super-vl-120b-a12b-nvfp4",
    stationExpressIntent: {
      version: 1,
      model: "nemotron-3.5-super-vl-120b",
      sandboxName: "my-assistant",
    },
  };

  it.each(["pending", "in_progress", "failed"])(
    "resumes the same Station selection while provider selection is %s",
    (status) => {
      const session = { ...stationSelection, steps: { provider_selection: { status } } };
      vi.stubEnv("NEMOCLAW_PROVIDER", "install-vllm");
      vi.stubEnv("NEMOCLAW_MODEL", session.model);
      expect(getResumeConfigConflicts(session, { nonInteractive: true })).toEqual([]);

      vi.stubEnv("NEMOCLAW_MODEL", "other-model");
      expect(getResumeConfigConflicts(session, { nonInteractive: true })).toContainEqual({
        field: "model",
        requested: "other-model",
        recorded: session.model,
      });
      vi.stubEnv("NEMOCLAW_PROVIDER", "build");
      expect(getResumeConfigConflicts(session, { nonInteractive: true })).toContainEqual({
        field: "provider",
        requested: "nvidia-prod",
        recorded: session.provider,
      });
    },
  );

  it.each([
    ["failed", undefined],
    ["failed", { version: 1 }],
    ["failed", { version: 1, kind: "spark", sandboxName: "my-assistant" }],
    ["complete", stationSelection.stationExpressIntent],
    [undefined, stationSelection.stationExpressIntent],
  ] as const)(
    "rejects install-vllm for status %s and intent %j",
    (status, stationExpressIntent) => {
      vi.stubEnv("NEMOCLAW_PROVIDER", "install-vllm");
      const session = {
        ...stationSelection,
        stationExpressIntent,
        steps: { provider_selection: { status } },
      };
      expect(getResumeConfigConflicts(session, { nonInteractive: true })).toContainEqual({
        field: "provider",
        requested: "install-vllm",
        recorded: session.provider,
      });
    },
  );
});

describe("resume provider conflict from the Deep Agents Code provider key", () => {
  const session = {
    sandboxName: "dcode",
    provider: "nvidia-prod",
    model: "nvidia/nemotron-3-ultra-550b-a55b",
    agent: "langchain-deepagents-code",
  };

  beforeEach(() => {
    for (const key of [
      "COMPATIBLE_API_KEY",
      "NEMOCLAW_AGENT",
      "NEMOCLAW_CLOUD_EXPERIMENTAL_MODEL",
      "NEMOCLAW_COMPAT_MODEL",
      "NEMOCLAW_E2E_USE_HOSTED_INFERENCE",
      "NEMOCLAW_ENDPOINT_URL",
      "NEMOCLAW_MODEL",
      "NEMOCLAW_PREFERRED_API",
      "NEMOCLAW_PROVIDER",
      "NEMOCLAW_PROVIDER_MODEL",
      "NVIDIA_INFERENCE_API_KEY",
    ]) {
      vi.stubEnv(key, undefined);
    }
    vi.stubEnv("NEMOCLAW_PROVIDER_KEY", "repo-hosted-key");
  });

  it.each(["langchain-deepagents-code", "dcode"])(
    "reports a compatible-endpoint provider conflict when the resumed run selects Deep Agents Code as %s",
    (agent) => {
      expect(getResumeConfigConflicts(session, { nonInteractive: true, agent })).toContainEqual({
        field: "provider",
        requested: "compatible-endpoint",
        recorded: "nvidia-prod",
      });
    },
  );

  it("reports no provider conflict when the resumed run selects Hermes and NEMOCLAW_AGENT names Deep Agents Code", () => {
    vi.stubEnv("NEMOCLAW_AGENT", "langchain-deepagents-code");

    expect(getResumeConfigConflicts(session, { nonInteractive: true, agent: "hermes" })).toEqual(
      [],
    );
    expect(process.env.COMPATIBLE_API_KEY).toBeUndefined();
  });
});

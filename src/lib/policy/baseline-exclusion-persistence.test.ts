// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";

const mocks = vi.hoisted(() => ({
  addBaselineExclusion: vi.fn(),
  beginBaselineExclusionTransition: vi.fn(),
  clearBaselineExclusionTransition: vi.fn(),
  commitBaselineExclusionTransition: vi.fn(),
  getBaselineExclusions: vi.fn(),
  getBaselineExclusionTransition: vi.fn(),
  getSandbox: vi.fn(),
  inspectSandboxPolicyAuthority: vi.fn(),
  removeBaselineExclusion: vi.fn(),
  run: vi.fn(),
  runCapture: vi.fn(),
}));

vi.mock("../adapters/openshell/policy-authority", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../adapters/openshell/policy-authority")>()),
  inspectSandboxPolicyAuthority: mocks.inspectSandboxPolicyAuthority,
}));

vi.mock("../runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runner")>()),
  run: mocks.run,
  runCapture: mocks.runCapture,
}));

vi.mock("../state/registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/registry")>()),
  addBaselineExclusion: mocks.addBaselineExclusion,
  beginBaselineExclusionTransition: mocks.beginBaselineExclusionTransition,
  clearBaselineExclusionTransition: mocks.clearBaselineExclusionTransition,
  commitBaselineExclusionTransition: mocks.commitBaselineExclusionTransition,
  getBaselineExclusions: mocks.getBaselineExclusions,
  getBaselineExclusionTransition: mocks.getBaselineExclusionTransition,
  getSandbox: mocks.getSandbox,
  removeBaselineExclusion: mocks.removeBaselineExclusion,
}));

import * as openshellResolveModule from "../adapters/openshell/resolve";
import { digestBaselineEntry, getBaselineEntry } from "./baseline-exclusion";
import {
  applyPresetContent,
  excludeBaselineEntry,
  getBaselineExclusionRuntimeStatus,
  loadPresetForSandbox,
  restoreBaselineEntry,
} from "./index";

const LIVE_POLICY = `version: 1
network_policies:
  nous_research:
    endpoints:
      - host: nousresearch.com
        port: 443
`;
const LIVE_ENTRY = getBaselineEntry(LIVE_POLICY, "nous_research");
const LIVE_DIGEST = digestBaselineEntry(LIVE_ENTRY!);
const HERMES_BASELINE = fs.readFileSync("agents/hermes/policy-additions.yaml", "utf8");
const HERMES_BASELINE_ENTRY = getBaselineEntry(HERMES_BASELINE, "nous_research");
const HERMES_BASELINE_DIGEST = digestBaselineEntry(HERMES_BASELINE_ENTRY!);
const HERMES_MANAGED_INFERENCE_DIGEST = digestBaselineEntry(
  getBaselineEntry(HERMES_BASELINE, "managed_inference")!,
);
const HERMES_RESTORED_POLICY = YAML.stringify({
  version: 1,
  network_policies: { nous_research: HERMES_BASELINE_ENTRY },
});
const OPENCLAW_BASELINE_ENTRY = getBaselineEntry(
  fs.readFileSync("nemoclaw-blueprint/policies/openclaw-sandbox.yaml", "utf8"),
  "managed_inference",
);
const OPENCLAW_BASELINE_DIGEST = digestBaselineEntry(OPENCLAW_BASELINE_ENTRY!);
const OPENCLAW_RESTORED_POLICY = YAML.stringify({
  version: 1,
  network_policies: { managed_inference: OPENCLAW_BASELINE_ENTRY },
});

function expectNoBaselineMutation(): void {
  expect(mocks.addBaselineExclusion).not.toHaveBeenCalled();
  expect(mocks.beginBaselineExclusionTransition).not.toHaveBeenCalled();
  expect(mocks.clearBaselineExclusionTransition).not.toHaveBeenCalled();
  expect(mocks.commitBaselineExclusionTransition).not.toHaveBeenCalled();
  expect(mocks.removeBaselineExclusion).not.toHaveBeenCalled();
  expect(mocks.run).not.toHaveBeenCalled();
}

describe("excludeBaselineEntry persistence boundary (#7178)", () => {
  beforeEach(() => {
    vi.spyOn(openshellResolveModule, "resolveOpenshell").mockReturnValue("/usr/bin/openshell");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.runCapture.mockReturnValue(LIVE_POLICY);
    mocks.run.mockReturnValue({ status: 0 });
    mocks.inspectSandboxPolicyAuthority.mockReturnValue({
      authority: "nemoclaw-managed",
      effectivePolicy: {},
    });
    mocks.getSandbox.mockReturnValue({
      name: "alpha",
      agent: "hermes",
      agentVersion: "1.2.3",
      policyAuthority: "nemoclaw-managed",
    });
    mocks.getBaselineExclusions.mockReturnValue([]);
    mocks.getBaselineExclusionTransition.mockReturnValue(null);
    mocks.beginBaselineExclusionTransition.mockReturnValue(false);
    mocks.clearBaselineExclusionTransition.mockReturnValue(true);
    mocks.commitBaselineExclusionTransition.mockReturnValue(true);
    mocks.addBaselineExclusion.mockReturnValue(true);
    mocks.removeBaselineExclusion.mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const mock of Object.values(mocks)) mock.mockReset();
  });

  it("does not narrow live egress when the exclusion cannot be recorded durably", () => {
    expect(excludeBaselineEntry("alpha", "nous_research", LIVE_DIGEST, { nonFatal: true })).toBe(
      false,
    );

    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.beginBaselineExclusionTransition).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({
        operation: "exclude",
        exclusion: expect.objectContaining({
          version: 1,
          agent: "hermes",
          key: "nous_research",
          digest: LIVE_DIGEST,
          appliedAgentVersion: "1.2.3",
        }),
        targetLiveDigest: null,
      }),
    );
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("no live policy changes"));
  });

  it("refuses exclusion journal changes when authority changes during the live read (#9833)", () => {
    mocks.inspectSandboxPolicyAuthority
      .mockReturnValueOnce({ authority: "nemoclaw-managed", effectivePolicy: {} })
      .mockReturnValueOnce({ authority: "externally-managed", effectivePolicy: {} });

    expect(excludeBaselineEntry("alpha", "nous_research", LIVE_DIGEST, { nonFatal: true })).toBe(
      false,
    );

    expectNoBaselineMutation();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("policy authority changed"));
  });

  it("preserves a pending exclusion when authority changes at the policy-set edge (#9833)", () => {
    mocks.beginBaselineExclusionTransition.mockReturnValue(true);
    mocks.inspectSandboxPolicyAuthority
      .mockReturnValueOnce({ authority: "nemoclaw-managed", effectivePolicy: {} })
      .mockReturnValueOnce({ authority: "nemoclaw-managed", effectivePolicy: {} })
      .mockReturnValue({ authority: "externally-managed", effectivePolicy: {} });

    expect(excludeBaselineEntry("alpha", "nous_research", LIVE_DIGEST, { nonFatal: true })).toBe(
      false,
    );

    expect(mocks.beginBaselineExclusionTransition).toHaveBeenCalledOnce();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.clearBaselineExclusionTransition).not.toHaveBeenCalled();
    expect(mocks.commitBaselineExclusionTransition).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("policy authority changed"));
  });

  it("clears a fresh transaction when live narrowing fails", () => {
    mocks.beginBaselineExclusionTransition.mockReturnValue(true);
    mocks.run.mockReturnValue({ status: 19 });

    expect(excludeBaselineEntry("alpha", "nous_research", LIVE_DIGEST, { nonFatal: true })).toBe(
      false,
    );

    const transaction = mocks.beginBaselineExclusionTransition.mock.calls[0]?.[1];
    expect(mocks.clearBaselineExclusionTransition).toHaveBeenCalledWith("alpha", transaction.id);
    expect(mocks.commitBaselineExclusionTransition).not.toHaveBeenCalled();
  });

  it("publishes committed intent only after exact live narrowing is verified", () => {
    mocks.beginBaselineExclusionTransition.mockReturnValue(true);
    mocks.runCapture
      .mockReturnValueOnce(LIVE_POLICY)
      .mockReturnValueOnce("version: 1\nnetwork_policies: {}\n");

    expect(excludeBaselineEntry("alpha", "nous_research", LIVE_DIGEST, { nonFatal: true })).toBe(
      true,
    );

    const transaction = mocks.beginBaselineExclusionTransition.mock.calls[0]?.[1];
    expect(mocks.commitBaselineExclusionTransition).toHaveBeenCalledWith("alpha", transaction.id);
    expect(mocks.clearBaselineExclusionTransition).not.toHaveBeenCalled();
  });

  it("commits when a failed OpenShell result nevertheless reached the exact live target", () => {
    mocks.beginBaselineExclusionTransition.mockReturnValue(true);
    mocks.run.mockReturnValue({ status: 19 });
    mocks.runCapture
      .mockReturnValueOnce(LIVE_POLICY)
      .mockReturnValueOnce("version: 1\nnetwork_policies: {}\n");

    expect(excludeBaselineEntry("alpha", "nous_research", LIVE_DIGEST, { nonFatal: true })).toBe(
      true,
    );

    expect(mocks.commitBaselineExclusionTransition).toHaveBeenCalledOnce();
    expect(mocks.clearBaselineExclusionTransition).not.toHaveBeenCalled();
  });

  it.each([
    ["returns false", () => false],
    [
      "throws",
      () => {
        throw new Error("disk unavailable");
      },
    ],
  ])("preserves a verified exclusion journal when finalization %s (#7178)", (_label, finalize) => {
    mocks.beginBaselineExclusionTransition.mockReturnValue(true);
    mocks.commitBaselineExclusionTransition.mockImplementation(finalize);
    mocks.runCapture
      .mockReturnValueOnce(LIVE_POLICY)
      .mockReturnValueOnce("version: 1\nnetwork_policies: {}\n");

    expect(excludeBaselineEntry("alpha", "nous_research", LIVE_DIGEST, { nonFatal: true })).toBe(
      false,
    );

    expect(mocks.commitBaselineExclusionTransition).toHaveBeenCalledOnce();
    expect(mocks.clearBaselineExclusionTransition).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("durable journal could not be finalized"),
    );
  });

  it("preserves the journal when post-write live readback is unavailable (#7178)", () => {
    mocks.beginBaselineExclusionTransition.mockReturnValue(true);
    mocks.runCapture.mockReturnValueOnce(LIVE_POLICY).mockReturnValueOnce("");

    expect(excludeBaselineEntry("alpha", "nous_research", LIVE_DIGEST, { nonFatal: true })).toBe(
      false,
    );

    expect(mocks.commitBaselineExclusionTransition).not.toHaveBeenCalled();
    expect(mocks.clearBaselineExclusionTransition).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Could not verify the live"),
    );
  });

  it("pins every live read and write to the sandbox's recorded gateway (#7178)", () => {
    vi.stubEnv("OPENSHELL_GATEWAY", "ambient-gateway");
    mocks.getSandbox.mockReturnValue({
      name: "alpha",
      agent: "hermes",
      agentVersion: "1.2.3",
      gatewayName: "nemoclaw-18080",
      gatewayPort: 18080,
      policyAuthority: "nemoclaw-managed",
    });
    mocks.beginBaselineExclusionTransition.mockReturnValue(true);
    mocks.runCapture
      .mockImplementationOnce((_command, options) => {
        expect(process.env.OPENSHELL_GATEWAY).toBe("ambient-gateway");
        expect(options).toMatchObject({ env: { OPENSHELL_GATEWAY: "nemoclaw-18080" } });
        return LIVE_POLICY;
      })
      .mockImplementationOnce((_command, options) => {
        expect(process.env.OPENSHELL_GATEWAY).toBe("ambient-gateway");
        expect(options).toMatchObject({ env: { OPENSHELL_GATEWAY: "nemoclaw-18080" } });
        return "version: 1\nnetwork_policies: {}\n";
      });
    mocks.run.mockImplementation((_command, options) => {
      expect(process.env.OPENSHELL_GATEWAY).toBe("ambient-gateway");
      expect(options).toMatchObject({ env: { OPENSHELL_GATEWAY: "nemoclaw-18080" } });
      return { status: 0 };
    });

    expect(excludeBaselineEntry("alpha", "nous_research", LIVE_DIGEST, { nonFatal: true })).toBe(
      true,
    );
    expect(process.env.OPENSHELL_GATEWAY).toBe("ambient-gateway");
  });

  it("rejects an ambient OpenShell gateway endpoint before live mutation (#7178)", () => {
    vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "https://other.example.test");

    expect(() =>
      excludeBaselineEntry("alpha", "nous_research", LIVE_DIGEST, { nonFatal: true }),
    ).toThrow(/OPENSHELL_GATEWAY_ENDPOINT is set/);
    expect(mocks.runCapture).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it.each([
    ["returns false", () => false],
    [
      "throws",
      () => {
        throw new Error("disk unavailable");
      },
    ],
  ])("preserves and reports the journal when exclusion compensation %s", (_label, compensate) => {
    mocks.beginBaselineExclusionTransition.mockReturnValue(true);
    mocks.run.mockReturnValue({ status: 19 });
    mocks.clearBaselineExclusionTransition.mockImplementation(compensate);

    expect(excludeBaselineEntry("alpha", "nous_research", LIVE_DIGEST, { nonFatal: true })).toBe(
      false,
    );

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("durable journal was preserved"),
    );
  });

  it("finalizes an interrupted exclusion when the exact live target is already present", () => {
    mocks.runCapture.mockReturnValue("version: 1\nnetwork_policies: {}\n");
    mocks.getBaselineExclusionTransition.mockReturnValue({
      id: "tx-exclude",
      operation: "exclude",
      exclusion: { version: 1, agent: "hermes", key: "nous_research", digest: LIVE_DIGEST },
      targetLiveDigest: null,
      startedAt: "2026-07-19T00:00:00.000Z",
    });

    expect(excludeBaselineEntry("alpha", "nous_research", LIVE_DIGEST, { nonFatal: true })).toBe(
      true,
    );

    expect(mocks.commitBaselineExclusionTransition).toHaveBeenCalledWith("alpha", "tx-exclude");
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("keeps an interrupted exclusion fail-closed when live policy matches neither side", () => {
    mocks.getBaselineExclusionTransition.mockReturnValue({
      id: "tx-exclude",
      operation: "exclude",
      exclusion: { version: 1, agent: "hermes", key: "nous_research", digest: LIVE_DIGEST },
      targetLiveDigest: null,
      startedAt: "2026-07-19T00:00:00.000Z",
    });
    mocks.runCapture.mockReturnValue(
      LIVE_POLICY.replace("nousresearch.com", "third-state.example.test"),
    );

    expect(excludeBaselineEntry("alpha", "nous_research", LIVE_DIGEST, { nonFatal: true })).toBe(
      false,
    );

    expect(mocks.commitBaselineExclusionTransition).not.toHaveBeenCalled();
    expect(mocks.clearBaselineExclusionTransition).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("matches neither side"));
  });

  it("does not mistake a malformed same-key live entry for the absent exclude target", () => {
    mocks.getBaselineExclusionTransition.mockReturnValue({
      id: "tx-exclude",
      operation: "exclude",
      exclusion: { version: 1, agent: "hermes", key: "nous_research", digest: LIVE_DIGEST },
      targetLiveDigest: null,
      startedAt: "2026-07-19T00:00:00.000Z",
    });
    mocks.runCapture.mockReturnValue("version: 1\nnetwork_policies:\n  nous_research: malformed\n");

    expect(excludeBaselineEntry("alpha", "nous_research", LIVE_DIGEST, { nonFatal: true })).toBe(
      false,
    );

    expect(mocks.commitBaselineExclusionTransition).not.toHaveBeenCalled();
    expect(mocks.clearBaselineExclusionTransition).not.toHaveBeenCalled();
  });

  it("refuses to remove a live entry that changed after the operator preview", () => {
    mocks.runCapture.mockReturnValue(
      LIVE_POLICY.replace("nousresearch.com", "changed.example.test"),
    );

    expect(excludeBaselineEntry("alpha", "nous_research", "stale-digest", { nonFatal: true })).toBe(
      false,
    );

    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.addBaselineExclusion).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("changed after preview"));
  });
});

describe("restoreBaselineEntry persistence boundary (#7178)", () => {
  const RECORDED = {
    version: 1 as const,
    agent: "hermes",
    key: "nous_research",
    digest: LIVE_DIGEST,
    acknowledgedAt: "2026-07-19T00:00:00.000Z",
  };

  beforeEach(() => {
    vi.spyOn(openshellResolveModule, "resolveOpenshell").mockReturnValue("/usr/bin/openshell");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.runCapture.mockReturnValue("version: 1\nnetwork_policies: {}\n");
    mocks.run.mockReturnValue({ status: 0 });
    mocks.inspectSandboxPolicyAuthority.mockReturnValue({
      authority: "nemoclaw-managed",
      effectivePolicy: {},
    });
    mocks.getSandbox.mockReturnValue({
      name: "alpha",
      agent: "hermes",
      agentVersion: "1.2.3",
      policyAuthority: "nemoclaw-managed",
    });
    mocks.getBaselineExclusions.mockReturnValue([RECORDED]);
    mocks.getBaselineExclusionTransition.mockReturnValue(null);
    mocks.beginBaselineExclusionTransition.mockReturnValue(true);
    mocks.clearBaselineExclusionTransition.mockReturnValue(true);
    mocks.commitBaselineExclusionTransition.mockReturnValue(true);
    mocks.removeBaselineExclusion.mockReturnValue(true);
    mocks.addBaselineExclusion.mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const mock of Object.values(mocks)) mock.mockReset();
  });

  it.each([
    ["changes", "nous_research", "stale-preview-digest", [RECORDED]],
    ["appears", "nous_research", null, [RECORDED]],
    ["disappears", "legacy_entry", LIVE_DIGEST, [{ ...RECORDED, key: "legacy_entry" }]],
  ] as const)(
    "does not mutate when the baseline entry %s after the operator preview",
    (_change, key, expectedTargetDigest, exclusions) => {
      mocks.getBaselineExclusions.mockReturnValue([...exclusions]);

      expect(restoreBaselineEntry("alpha", key, { nonFatal: true, expectedTargetDigest })).toBe(
        false,
      );

      expect(mocks.runCapture).not.toHaveBeenCalled();
      expect(mocks.run).not.toHaveBeenCalled();
      expect(mocks.beginBaselineExclusionTransition).not.toHaveBeenCalled();
      expect(mocks.clearBaselineExclusionTransition).not.toHaveBeenCalled();
      expect(mocks.commitBaselineExclusionTransition).not.toHaveBeenCalled();
      expect(mocks.removeBaselineExclusion).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining("changed after preview"));
    },
  );

  it("does not widen live egress when its durable transaction cannot be recorded", () => {
    mocks.beginBaselineExclusionTransition.mockReturnValue(false);

    expect(restoreBaselineEntry("alpha", "nous_research", { nonFatal: true })).toBe(false);

    expect(mocks.run).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("no live policy changes"));
  });

  it("refuses restore journal changes when authority changes during the live read (#9833)", () => {
    mocks.inspectSandboxPolicyAuthority
      .mockReturnValueOnce({ authority: "nemoclaw-managed", effectivePolicy: {} })
      .mockReturnValueOnce({ authority: "externally-managed", effectivePolicy: {} });

    expect(restoreBaselineEntry("alpha", "nous_research", { nonFatal: true })).toBe(false);

    expectNoBaselineMutation();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("policy authority changed"));
  });

  it("clears the restore transaction when live policy restoration fails", () => {
    mocks.run.mockReturnValue({ status: 19 });

    expect(restoreBaselineEntry("alpha", "nous_research", { nonFatal: true })).toBe(false);

    const transaction = mocks.beginBaselineExclusionTransition.mock.calls[0]?.[1];
    expect(mocks.clearBaselineExclusionTransition).toHaveBeenCalledWith("alpha", transaction.id);
    expect(mocks.commitBaselineExclusionTransition).not.toHaveBeenCalled();
  });

  it("publishes the restore only after exact live widening is verified", () => {
    expect(HERMES_BASELINE_ENTRY).not.toBeNull();
    mocks.runCapture
      .mockReturnValueOnce("version: 1\nnetwork_policies: {}\n")
      .mockReturnValueOnce(HERMES_RESTORED_POLICY);

    expect(restoreBaselineEntry("alpha", "nous_research", { nonFatal: true })).toBe(true);

    const transaction = mocks.beginBaselineExclusionTransition.mock.calls[0]?.[1];
    expect(mocks.commitBaselineExclusionTransition).toHaveBeenCalledWith("alpha", transaction.id);
    expect(mocks.clearBaselineExclusionTransition).not.toHaveBeenCalled();
  });

  it("restores the current baseline before clearing an exclusion recorded for another agent (#7194)", () => {
    const staleExclusion = {
      ...RECORDED,
      agent: "hermes",
      key: "managed_inference",
      digest: HERMES_MANAGED_INFERENCE_DIGEST,
    };
    mocks.getSandbox.mockReturnValue({
      name: "alpha",
      agent: "openclaw",
      agentVersion: "2.0.0",
      policyAuthority: "nemoclaw-managed",
    });
    mocks.getBaselineExclusions.mockReturnValue([staleExclusion]);
    mocks.runCapture
      .mockReturnValueOnce("version: 1\nnetwork_policies: {}\n")
      .mockReturnValueOnce(OPENCLAW_RESTORED_POLICY);

    expect(OPENCLAW_BASELINE_ENTRY).not.toBeNull();
    expect(restoreBaselineEntry("alpha", "managed_inference", { nonFatal: true })).toBe(true);

    expect(mocks.beginBaselineExclusionTransition).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({
        operation: "restore",
        exclusion: staleExclusion,
        targetLiveDigest: OPENCLAW_BASELINE_DIGEST,
      }),
    );
    expect(mocks.run).toHaveBeenCalledOnce();
    const transaction = mocks.beginBaselineExclusionTransition.mock.calls[0]?.[1];
    expect(mocks.commitBaselineExclusionTransition).toHaveBeenCalledWith("alpha", transaction.id);
    expect(mocks.removeBaselineExclusion).not.toHaveBeenCalled();
  });

  it.each([
    ["returns false", () => false],
    [
      "throws",
      () => {
        throw new Error("disk unavailable");
      },
    ],
  ])("preserves and reports the journal when restore compensation %s", (_label, compensate) => {
    mocks.run.mockReturnValue({ status: 19 });
    mocks.clearBaselineExclusionTransition.mockImplementation(compensate);

    expect(restoreBaselineEntry("alpha", "nous_research", { nonFatal: true })).toBe(false);

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("durable journal was preserved"),
    );
  });

  it("finalizes an interrupted restore when the exact live target is already present", () => {
    mocks.runCapture.mockReturnValue(HERMES_RESTORED_POLICY);
    mocks.getBaselineExclusionTransition.mockReturnValue({
      id: "tx-restore",
      operation: "restore",
      exclusion: RECORDED,
      targetLiveDigest: HERMES_BASELINE_DIGEST,
      startedAt: "2026-07-19T00:00:00.000Z",
    });

    expect(restoreBaselineEntry("alpha", "nous_research", { nonFatal: true })).toBe(true);

    expect(mocks.commitBaselineExclusionTransition).toHaveBeenCalledWith("alpha", "tx-restore");
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("keeps an interrupted restore pending when the release baseline changed (#7178)", () => {
    mocks.runCapture.mockReturnValue(LIVE_POLICY);
    mocks.getBaselineExclusionTransition.mockReturnValue({
      id: "tx-restore",
      operation: "restore",
      exclusion: RECORDED,
      targetLiveDigest: LIVE_DIGEST,
      startedAt: "2026-07-19T00:00:00.000Z",
    });

    expect(restoreBaselineEntry("alpha", "nous_research", { nonFatal: true })).toBe(false);

    expect(mocks.commitBaselineExclusionTransition).not.toHaveBeenCalled();
    expect(mocks.clearBaselineExclusionTransition).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("current release baseline for 'nous_research' changed"),
    );
  });

  it("keeps an interrupted restore pending when the release baseline removed its key (#7178)", () => {
    const legacyTargetPolicy = YAML.stringify({
      version: 1,
      network_policies: { legacy_entry: LIVE_ENTRY },
    });
    const legacyExclusion = {
      version: 1 as const,
      agent: "hermes",
      key: "legacy_entry",
      digest: "a".repeat(64),
      acknowledgedAt: "2026-07-19T00:00:00.000Z",
    };
    mocks.runCapture.mockReturnValue(legacyTargetPolicy);
    mocks.getBaselineExclusions.mockReturnValue([legacyExclusion]);
    mocks.getBaselineExclusionTransition.mockReturnValue({
      id: "tx-restore",
      operation: "restore",
      exclusion: legacyExclusion,
      targetLiveDigest: LIVE_DIGEST,
      startedAt: "2026-07-19T00:00:00.000Z",
    });

    expect(restoreBaselineEntry("alpha", "legacy_entry", { nonFatal: true })).toBe(false);

    expect(mocks.commitBaselineExclusionTransition).not.toHaveBeenCalled();
    expect(mocks.clearBaselineExclusionTransition).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("current release baseline for 'legacy_entry' changed"),
    );
  });

  it("keeps an interrupted restore pending when its agent baseline is unreadable (#7178)", () => {
    mocks.getSandbox.mockReturnValue({
      name: "alpha",
      agent: "agent-without-a-readable-baseline",
      agentVersion: "1.2.3",
      policyAuthority: "nemoclaw-managed",
    });
    mocks.runCapture.mockReturnValue(LIVE_POLICY);
    mocks.getBaselineExclusionTransition.mockReturnValue({
      id: "tx-restore",
      operation: "restore",
      exclusion: RECORDED,
      targetLiveDigest: LIVE_DIGEST,
      startedAt: "2026-07-19T00:00:00.000Z",
    });

    expect(restoreBaselineEntry("alpha", "nous_research", { nonFatal: true })).toBe(false);

    expect(mocks.runCapture).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.beginBaselineExclusionTransition).not.toHaveBeenCalled();
    expect(mocks.commitBaselineExclusionTransition).not.toHaveBeenCalled();
    expect(mocks.clearBaselineExclusionTransition).not.toHaveBeenCalled();
    expect(mocks.removeBaselineExclusion).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("current release baseline for 'nous_research' is unreadable"),
    );
  });

  it("keeps an interrupted restore pending when durable exclusion intent changed (#7178)", () => {
    mocks.runCapture.mockReturnValue(HERMES_RESTORED_POLICY);
    mocks.getBaselineExclusions.mockReturnValue([{ ...RECORDED, digest: "changed" }]);
    mocks.getBaselineExclusionTransition.mockReturnValue({
      id: "tx-restore",
      operation: "restore",
      exclusion: RECORDED,
      targetLiveDigest: HERMES_BASELINE_DIGEST,
      startedAt: "2026-07-19T00:00:00.000Z",
    });

    expect(restoreBaselineEntry("alpha", "nous_research", { nonFatal: true })).toBe(false);

    expect(mocks.commitBaselineExclusionTransition).not.toHaveBeenCalled();
    expect(mocks.clearBaselineExclusionTransition).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("durable exclusion for 'nous_research' changed"),
    );
  });
});

describe("baseline exclusion live verification boundary (#7194)", () => {
  const exclusion = {
    version: 1 as const,
    agent: "hermes",
    key: "nous_research",
    digest: HERMES_BASELINE_DIGEST,
  };

  beforeEach(() => {
    mocks.getSandbox.mockReturnValue({ name: "alpha", agent: "hermes" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const mock of Object.values(mocks)) mock.mockReset();
  });

  it("reports a mismatch when the excluded key remains in the observed live policy", () => {
    mocks.runCapture.mockReturnValue(HERMES_RESTORED_POLICY);

    expect(getBaselineExclusionRuntimeStatus("alpha", exclusion)).toBe("live-policy-mismatch");
  });

  it("reports excluded only when the observed live policy omits the reviewed key", () => {
    mocks.runCapture.mockReturnValue("version: 1\nnetwork_policies: {}\n");

    expect(getBaselineExclusionRuntimeStatus("alpha", exclusion)).toBe("excluded");
  });

  it("refuses to reintroduce an excluded Hermes pypi key through a live preset (#7194)", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const pypiPreset = loadPresetForSandbox("alpha", "pypi");
    expect(pypiPreset).not.toBeNull();
    mocks.getBaselineExclusions.mockReturnValue([{ ...exclusion, key: "pypi" }]);

    expect(applyPresetContent("alpha", "pypi", pypiPreset!, { nonFatal: true })).toBe(false);
    expect(mocks.runCapture).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("reserved by a baseline exclusion"),
    );
  });
});

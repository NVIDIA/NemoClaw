// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";

const state = vi.hoisted(() => ({
  beginAllowed: true,
  clearAllowed: true,
  commitAllowed: true,
  customPolicies: [] as Array<{
    name: string;
    content: string;
    sourcePath?: string;
    appliedAt?: string;
  }>,
  livePolicy: "",
  setCalls: 0,
  setMode: "apply" as "apply" | "fail-source" | "fail-target" | "third" | "unreadable-after",
  transition: null as import("../state/registry").CustomPolicyTransition | null,
}));

const mocks = vi.hoisted(() => ({
  beginCustomPolicyTransition: vi.fn(),
  clearCustomPolicyTransition: vi.fn(),
  commitCustomPolicyTransition: vi.fn(),
  getBaselineExclusions: vi.fn(() => []),
  getBaselineExclusionTransition: vi.fn(() => null),
  getCustomPolicies: vi.fn(),
  getCustomPolicyTransition: vi.fn(),
  getSandbox: vi.fn(),
  run: vi.fn(),
  runCapture: vi.fn(),
}));

vi.mock("../runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runner")>()),
  run: mocks.run,
  runCapture: mocks.runCapture,
}));

vi.mock("../state/registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/registry")>()),
  beginCustomPolicyTransition: mocks.beginCustomPolicyTransition,
  clearCustomPolicyTransition: mocks.clearCustomPolicyTransition,
  commitCustomPolicyTransition: mocks.commitCustomPolicyTransition,
  getBaselineExclusions: mocks.getBaselineExclusions,
  getBaselineExclusionTransition: mocks.getBaselineExclusionTransition,
  getCustomPolicies: mocks.getCustomPolicies,
  getCustomPolicyTransition: mocks.getCustomPolicyTransition,
  getSandbox: mocks.getSandbox,
}));

import * as openshellResolveModule from "../adapters/openshell/resolve";
import { MCP_BRIDGE_POLICY_SOURCE } from "../state/registry-mcp";
import { applyPresetContent, removePreset, repairPendingCustomPolicyApply } from "./index";

const OLD = `preset:
  name: custom-egress
network_policies:
  old_only:
    name: old-only
    endpoints:
      - host: old.example.com
        port: 443
  shared:
    name: old-shared
    endpoints:
      - host: shared.example.com
        port: 443
`;

const DESIRED = `preset:
  name: custom-egress
network_policies:
  shared:
    name: desired-shared
    endpoints:
      - host: shared.example.com
        port: 443
  desired_only:
    name: desired-only
    endpoints:
      - host: desired.example.com
        port: 443
`;

const FRESH = `preset:
  name: fresh-egress
network_policies:
  fresh:
    name: fresh
    endpoints:
      - host: fresh.example.com
        port: 443
`;

const EMPTY = `preset:
  name: empty-egress
network_policies:
  {}
`;

const PRIVATE = `preset:
  name: private-egress
network_policies:
  private:
    name: private
    endpoints:
      - host: api.corp.example
        port: 443
        allowed_ips: [10.20.30.40]
`;

const DANGEROUS = `preset:
  name: dangerous-egress
network_policies:
  dangerous:
    name: dangerous
    endpoints:
      - host: "*"
        port: 443
`;

const UNRELATED = {
  unrelated: {
    name: "unrelated",
    endpoints: [{ host: "unrelated.example.com", port: 443 }],
  },
};

const EXTERNAL_APPLY_REPAIR = { dryRun: false, externalSource: true };

function policyEntries(content: string): Record<string, unknown> {
  return YAML.parse(content).network_policies;
}

function livePolicy(entries: Record<string, unknown>): string {
  return YAML.stringify({ version: 1, network_policies: entries });
}

function previousEntry() {
  return {
    name: "custom-egress",
    content: OLD,
    sourcePath: "/tmp/custom-egress.yaml",
    appliedAt: "2026-08-06T12:00:00.000Z",
  };
}

function emptyEntry() {
  return {
    name: "empty-egress",
    content: EMPTY,
    sourcePath: "/tmp/empty-egress.yaml",
    appliedAt: "2026-08-06T12:01:00.000Z",
  };
}

function pendingApply(
  previous: ReturnType<typeof previousEntry> | null,
  desiredName = "fresh-egress",
  desiredContent = FRESH,
): import("../state/registry").CustomPolicyTransition {
  return {
    version: 1,
    id: "123e4567-e89b-42d3-a456-426614174070",
    operation: "apply",
    name: desiredName,
    previous,
    desired: {
      name: desiredName,
      content: desiredContent,
      sourcePath: `/tmp/${desiredName}.yaml`,
      appliedAt: "2026-08-06T12:01:00.000Z",
    },
    startedAt: "2026-08-06T12:02:00.000Z",
  };
}

describe("custom policy transaction boundary (#8176)", () => {
  beforeEach(() => {
    state.beginAllowed = true;
    state.clearAllowed = true;
    state.commitAllowed = true;
    state.customPolicies = [];
    state.livePolicy = livePolicy(UNRELATED);
    state.setCalls = 0;
    state.setMode = "apply";
    state.transition = null;

    vi.spyOn(openshellResolveModule, "resolveOpenshell").mockReturnValue("/usr/bin/openshell");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    mocks.getSandbox.mockImplementation(() => ({
      name: "alpha",
      gatewayName: "nemoclaw",
      policies: [],
      customPolicies: state.customPolicies,
    }));
    mocks.getCustomPolicies.mockImplementation(() => state.customPolicies);
    mocks.getCustomPolicyTransition.mockImplementation(() => state.transition);
    mocks.beginCustomPolicyTransition.mockImplementation((_sandbox, transition) => {
      if (!state.beginAllowed || state.transition) return false;
      state.transition = structuredClone(transition);
      return true;
    });
    mocks.clearCustomPolicyTransition.mockImplementation((_sandbox, id) => {
      if (!state.clearAllowed || state.transition?.id !== id) return false;
      state.transition = null;
      return true;
    });
    mocks.commitCustomPolicyTransition.mockImplementation((_sandbox, id) => {
      const transition = state.transition;
      if (!state.commitAllowed || !transition || transition.id !== id) return false;
      state.customPolicies = state.customPolicies.filter((entry) => entry.name !== transition.name);
      if (transition.desired) state.customPolicies.push(structuredClone(transition.desired));
      state.transition = null;
      return true;
    });
    mocks.runCapture.mockImplementation(() => {
      if (state.setMode === "unreadable-after" && state.setCalls > 0) {
        throw new Error("gateway unavailable");
      }
      return state.livePolicy;
    });
    mocks.run.mockImplementation((args: string[]) => {
      state.setCalls += 1;
      const policyPath = args[args.indexOf("--policy") + 1];
      const desiredPolicy = fs.readFileSync(policyPath, "utf8");
      if (state.setMode === "apply" || state.setMode === "fail-target") {
        state.livePolicy = desiredPolicy;
      } else if (state.setMode === "third") {
        const document = YAML.parse(desiredPolicy);
        document.network_policies.fresh = {
          name: "concurrent-writer",
          endpoints: [{ host: "other.example.com", port: 443 }],
        };
        state.livePolicy = YAML.stringify(document);
      }
      return {
        status: state.setMode === "fail-source" || state.setMode === "fail-target" ? 19 : 0,
        stdout: "",
        stderr: "",
      };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const mock of Object.values(mocks)) mock.mockReset();
  });

  it("does not mutate live policy when the journal cannot be persisted", () => {
    state.beginAllowed = false;

    expect(
      applyPresetContent("alpha", "fresh-egress", FRESH, {
        custom: { sourcePath: "/tmp/fresh-egress.yaml" },
      }),
    ).toBe(false);

    expect(mocks.run).not.toHaveBeenCalled();
    expect(state.transition).toBeNull();
  });

  it("records an empty custom apply without writing the unchanged live policy", () => {
    expect(
      applyPresetContent("alpha", "empty-egress", EMPTY, {
        custom: { sourcePath: "/tmp/empty-egress.yaml" },
      }),
    ).toBe(true);

    expect(mocks.run).not.toHaveBeenCalled();
    expect(state.customPolicies).toEqual([
      expect.objectContaining({
        name: "empty-egress",
        content: EMPTY,
        sourcePath: "/tmp/empty-egress.yaml",
      }),
    ]);
    expect(state.transition).toBeNull();
  });

  it("removes an empty custom policy without writing the unchanged live policy", () => {
    state.customPolicies = [emptyEntry()];

    expect(removePreset("alpha", "empty-egress", { nonFatal: true })).toBe(true);

    expect(mocks.run).not.toHaveBeenCalled();
    expect(state.customPolicies).toEqual([]);
    expect(state.transition).toBeNull();
  });

  it.each([
    "apply",
    "remove",
  ] as const)("does not let ordinary custom policy %s take over managed MCP ownership", (operation) => {
    state.customPolicies = [
      {
        ...previousEntry(),
        sourcePath: MCP_BRIDGE_POLICY_SOURCE,
      },
    ];
    state.livePolicy = livePolicy({ ...UNRELATED, ...policyEntries(OLD) });

    const result =
      operation === "apply"
        ? applyPresetContent("alpha", "custom-egress", DESIRED, {
            custom: { sourcePath: "/tmp/custom-egress.yaml" },
          })
        : removePreset("alpha", "custom-egress", { nonFatal: true });

    expect(result).toBe(false);
    expect(mocks.runCapture).not.toHaveBeenCalled();
    expect(mocks.beginCustomPolicyTransition).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(state.customPolicies).toEqual([
      expect.objectContaining({
        name: "custom-egress",
        sourcePath: MCP_BRIDGE_POLICY_SOURCE,
      }),
    ]);
    expect(state.transition).toBeNull();
  });

  it("clears a fresh journal when the failed write leaves the exact source", () => {
    state.setMode = "fail-source";

    expect(
      applyPresetContent("alpha", "fresh-egress", FRESH, {
        custom: { sourcePath: "/tmp/fresh-egress.yaml" },
      }),
    ).toBe(false);

    expect(mocks.clearCustomPolicyTransition).toHaveBeenCalledOnce();
    expect(state.transition).toBeNull();
    expect(state.customPolicies).toEqual([]);
  });

  it("commits when a failed command nevertheless reaches the exact target", () => {
    state.setMode = "fail-target";

    expect(
      applyPresetContent("alpha", "fresh-egress", FRESH, {
        custom: { sourcePath: "/tmp/fresh-egress.yaml" },
      }),
    ).toBe(true);

    expect(mocks.commitCustomPolicyTransition).toHaveBeenCalledOnce();
    expect(state.customPolicies).toEqual([
      expect.objectContaining({ name: "fresh-egress", content: FRESH }),
    ]);
  });

  it.each([
    "unreadable-after",
    "third",
  ] as const)("preserves the journal when the post-write state is %s", (setMode) => {
    state.setMode = setMode;

    expect(
      applyPresetContent("alpha", "fresh-egress", FRESH, {
        custom: { sourcePath: "/tmp/fresh-egress.yaml" },
      }),
    ).toBe(false);

    expect(state.transition).toMatchObject({ operation: "apply", name: "fresh-egress" });
    expect(mocks.commitCustomPolicyTransition).not.toHaveBeenCalled();
    expect(mocks.clearCustomPolicyTransition).not.toHaveBeenCalled();
  });

  it("preserves a verified target journal when registry commit fails", () => {
    state.commitAllowed = false;

    expect(
      applyPresetContent("alpha", "fresh-egress", FRESH, {
        custom: { sourcePath: "/tmp/fresh-egress.yaml" },
      }),
    ).toBe(false);

    expect(state.transition).toMatchObject({ operation: "apply", name: "fresh-egress" });
  });

  it("finishes an exact target on retry without another live mutation", () => {
    state.transition = pendingApply(null);
    state.livePolicy = livePolicy({ ...UNRELATED, ...policyEntries(FRESH) });

    expect(
      applyPresetContent("alpha", "fresh-egress", FRESH, {
        custom: { sourcePath: "/tmp/fresh-egress.yaml" },
      }),
    ).toBe(true);

    expect(mocks.commitCustomPolicyTransition).toHaveBeenCalledOnce();
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("rolls back an exact source journal before retrying the same apply", () => {
    state.transition = pendingApply(null);

    expect(
      applyPresetContent("alpha", "fresh-egress", FRESH, {
        custom: { sourcePath: "/tmp/fresh-egress.yaml" },
      }),
    ).toBe(true);

    expect(mocks.clearCustomPolicyTransition).toHaveBeenCalledOnce();
    expect(mocks.beginCustomPolicyTransition).toHaveBeenCalledOnce();
    expect(mocks.run).toHaveBeenCalledOnce();
  });

  it("finalizes a pending apply target without loading external intent", () => {
    state.transition = pendingApply(null);
    state.livePolicy = livePolicy({ ...UNRELATED, ...policyEntries(FRESH) });

    expect(repairPendingCustomPolicyApply("alpha", EXTERNAL_APPLY_REPAIR)).toEqual({
      state: "completed",
      presetName: "fresh-egress",
    });

    expect(mocks.commitCustomPolicyTransition).toHaveBeenCalledOnce();
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("finalizes an empty pending apply without writing live policy", () => {
    state.transition = pendingApply(null, "empty-egress", EMPTY);

    expect(repairPendingCustomPolicyApply("alpha", EXTERNAL_APPLY_REPAIR)).toEqual({
      state: "completed",
      presetName: "empty-egress",
    });

    expect(mocks.commitCustomPolicyTransition).toHaveBeenCalledOnce();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(state.customPolicies).toEqual([expect.objectContaining(emptyEntry())]);
  });

  it("finalizes an empty pending remove without writing live policy", () => {
    const previous = emptyEntry();
    state.customPolicies = [previous];
    state.transition = {
      ...pendingApply(previous, "empty-egress", EMPTY),
      operation: "remove",
      desired: null,
    };

    expect(removePreset("alpha", "empty-egress", { nonFatal: true })).toBe(true);

    expect(mocks.commitCustomPolicyTransition).toHaveBeenCalledOnce();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(state.customPolicies).toEqual([]);
  });

  it("retries a pending apply from its durable target receipt", () => {
    state.transition = pendingApply(null);

    expect(repairPendingCustomPolicyApply("alpha", EXTERNAL_APPLY_REPAIR)).toEqual({
      state: "completed",
      presetName: "fresh-egress",
    });

    expect(mocks.run).toHaveBeenCalledOnce();
    expect(mocks.clearCustomPolicyTransition).not.toHaveBeenCalled();
    expect(state.customPolicies).toEqual([
      expect.objectContaining({ name: "fresh-egress", content: FRESH }),
    ]);
    expect(state.transition).toBeNull();
  });

  it("repairs a pending private apply only from its content-bound pin receipt", () => {
    const transition = pendingApply(null, "private-egress", PRIVATE);
    if (!transition.desired) throw new Error("test fixture requires a desired entry");
    transition.desired.trustedPrivatePins = {
      version: 1,
      contentDigest: createHash("sha256").update(PRIVATE).digest("hex"),
    };
    state.transition = transition;

    expect(repairPendingCustomPolicyApply("alpha", EXTERNAL_APPLY_REPAIR)).toEqual({
      state: "completed",
      presetName: "private-egress",
    });

    expect(mocks.run).toHaveBeenCalledOnce();
    expect(mocks.commitCustomPolicyTransition).toHaveBeenCalledOnce();
    expect(state.customPolicies).toEqual([
      expect.objectContaining({
        name: "private-egress",
        content: PRIVATE,
        trustedPrivatePins: transition.desired.trustedPrivatePins,
      }),
    ]);
    expect(state.transition).toBeNull();
  });

  it("does not inspect or mutate live policy for a private repair without pin authority", () => {
    state.transition = pendingApply(null, "private-egress", PRIVATE);

    expect(repairPendingCustomPolicyApply("alpha", EXTERNAL_APPLY_REPAIR)).toEqual({
      state: "blocked",
    });

    expect(mocks.runCapture).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.commitCustomPolicyTransition).not.toHaveBeenCalled();
    expect(mocks.clearCustomPolicyTransition).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("'allowed_ips'"));
    expect(state.transition).toMatchObject({ operation: "apply", name: "private-egress" });
  });

  it("does not inspect or mutate live policy for malformed desired content", () => {
    state.transition = pendingApply(
      null,
      "malformed-egress",
      "network_policies:\n  malformed: not-a-policy-map\n",
    );

    expect(repairPendingCustomPolicyApply("alpha", EXTERNAL_APPLY_REPAIR)).toEqual({
      state: "blocked",
    });

    expect(mocks.runCapture).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.commitCustomPolicyTransition).not.toHaveBeenCalled();
    expect(mocks.clearCustomPolicyTransition).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("invalid desired content"));
    expect(state.transition).toMatchObject({ operation: "apply", name: "malformed-egress" });
  });

  it("does not commit or mutate an unsafe repair target even when it is already live", () => {
    state.transition = pendingApply(null, "dangerous-egress", DANGEROUS);
    state.livePolicy = livePolicy({ ...UNRELATED, ...policyEntries(DANGEROUS) });

    expect(repairPendingCustomPolicyApply("alpha", EXTERNAL_APPLY_REPAIR)).toEqual({
      state: "blocked",
    });

    expect(mocks.runCapture).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.commitCustomPolicyTransition).not.toHaveBeenCalled();
    expect(mocks.clearCustomPolicyTransition).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("unsafe endpoint"));
    expect(state.transition).toMatchObject({ operation: "apply", name: "dangerous-egress" });
  });

  it("does not inspect or mutate a repair journal that claims managed MCP ownership", () => {
    const transition = pendingApply(null);
    if (!transition.desired) throw new Error("test fixture requires a desired entry");
    transition.desired.sourcePath = MCP_BRIDGE_POLICY_SOURCE;
    state.transition = transition;

    expect(repairPendingCustomPolicyApply("alpha", EXTERNAL_APPLY_REPAIR)).toEqual({
      state: "blocked",
    });

    expect(mocks.runCapture).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.commitCustomPolicyTransition).not.toHaveBeenCalled();
    expect(mocks.clearCustomPolicyTransition).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("managed MCP ownership"));
    expect(state.transition).toMatchObject({ operation: "apply", name: "fresh-egress" });
  });

  it("preserves a pending apply journal when its durable retry stays at source", () => {
    state.transition = pendingApply(null);
    state.setMode = "fail-source";

    expect(repairPendingCustomPolicyApply("alpha", EXTERNAL_APPLY_REPAIR)).toEqual({
      state: "blocked",
    });

    expect(mocks.run).toHaveBeenCalledOnce();
    expect(mocks.clearCustomPolicyTransition).not.toHaveBeenCalled();
    expect(mocks.commitCustomPolicyTransition).not.toHaveBeenCalled();
    expect(state.transition).toMatchObject({ operation: "apply", name: "fresh-egress" });
  });

  it("preserves a pending apply journal when live state matches neither receipt", () => {
    state.transition = pendingApply(null);
    state.livePolicy = livePolicy({
      ...UNRELATED,
      fresh: {
        name: "foreign",
        endpoints: [{ host: "foreign.example.com", port: 443 }],
      },
    });

    expect(repairPendingCustomPolicyApply("alpha", EXTERNAL_APPLY_REPAIR)).toEqual({
      state: "blocked",
    });

    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.clearCustomPolicyTransition).not.toHaveBeenCalled();
    expect(mocks.commitCustomPolicyTransition).not.toHaveBeenCalled();
  });

  it("does not treat a pending remove as an apply repair", () => {
    state.transition = {
      ...pendingApply(previousEntry(), "custom-egress", DESIRED),
      operation: "remove",
      desired: null,
    };

    expect(repairPendingCustomPolicyApply("alpha", EXTERNAL_APPLY_REPAIR)).toEqual({
      state: "blocked",
    });

    expect(mocks.runCapture).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(state.transition).toMatchObject({ operation: "remove", name: "custom-egress" });
  });

  it("does not mutate a pending apply during dry-run", () => {
    state.transition = pendingApply(null);

    expect(repairPendingCustomPolicyApply("alpha", { dryRun: true, externalSource: true })).toEqual(
      { state: "blocked" },
    );

    expect(mocks.runCapture).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.commitCustomPolicyTransition).not.toHaveBeenCalled();
    expect(mocks.clearCustomPolicyTransition).not.toHaveBeenCalled();
    expect(state.transition).toMatchObject({ operation: "apply", name: "fresh-egress" });
  });

  it("does not consume a built-in add while an external apply needs repair", () => {
    state.transition = pendingApply(null);

    expect(
      repairPendingCustomPolicyApply("alpha", { dryRun: false, externalSource: false }),
    ).toEqual({ state: "blocked" });

    expect(mocks.runCapture).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.commitCustomPolicyTransition).not.toHaveBeenCalled();
    expect(mocks.clearCustomPolicyTransition).not.toHaveBeenCalled();
    expect(state.transition).toMatchObject({ operation: "apply", name: "fresh-egress" });
  });

  it("replaces in one document, removing previous-only keys and preserving unrelated keys", () => {
    state.customPolicies = [previousEntry()];
    state.livePolicy = livePolicy({ ...UNRELATED, ...policyEntries(OLD) });

    expect(
      applyPresetContent("alpha", "custom-egress", DESIRED, {
        custom: { sourcePath: "/tmp/custom-egress.yaml" },
      }),
    ).toBe(true);

    const finalPolicies = YAML.parse(state.livePolicy).network_policies;
    expect(finalPolicies).toMatchObject({ ...UNRELATED, ...policyEntries(DESIRED) });
    expect(finalPolicies).not.toHaveProperty("old_only");
  });

  it("refuses to remove a registered key whose live value drifted", () => {
    state.customPolicies = [previousEntry()];
    state.livePolicy = livePolicy({
      ...UNRELATED,
      ...policyEntries(OLD),
      old_only: {
        name: "foreign-replacement",
        endpoints: [{ host: "foreign.example.com", port: 443 }],
      },
    });

    expect(removePreset("alpha", "custom-egress", { nonFatal: true })).toBe(false);

    expect(mocks.beginCustomPolicyTransition).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(state.customPolicies).toEqual([previousEntry()]);
  });

  it("removes a legacy custom policy whose RFC 1123 name exceeds 63 characters", () => {
    const legacyName = "a".repeat(64);
    const legacyEntry = { ...previousEntry(), name: legacyName };
    state.customPolicies = [legacyEntry];
    state.livePolicy = livePolicy({ ...UNRELATED, ...policyEntries(OLD) });

    expect(removePreset("alpha", legacyName, { nonFatal: true })).toBe(true);

    expect(mocks.beginCustomPolicyTransition).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ operation: "remove", name: legacyName, previous: legacyEntry }),
    );
    expect(state.customPolicies).toEqual([]);
    expect(state.transition).toBeNull();
  });
});

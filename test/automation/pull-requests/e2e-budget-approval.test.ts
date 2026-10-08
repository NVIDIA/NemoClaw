// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  e2eBudgetChangeDigest,
  hasMaintainerBudgetApproval,
} from "../../helpers/e2e-budget-approval";
import { e2eAssertionBudgetGrowthViolations } from "../../helpers/growth-guardrail-checks";

const BUDGET = "ci/e2e-assertion-budget.json";
const POLICY = "ci/e2e-assertion-growth-exceptions.json";
const source = readFileSync(
  new URL("../../../ci/e2e-assertion-budget.json", import.meta.url),
  "utf8",
);
const PR = 123;
const HASH = "a".repeat(64);

function changedBudget(increase = 1) {
  const budget = JSON.parse(source);
  budget.limits.unique.assertionPoints += increase;
  budget.limits.files[Object.keys(budget.limits.files)[0]][1] += increase;
  return budget;
}

function record(action = "approve", digest = HASH, login = "maintainer", type = "User") {
  return {
    body: `NemoClaw-E2E-Growth: ${action} ${digest}`,
    user: { login, type },
    created_at: "2026-10-08T00:00:00Z",
    updated_at: "2026-10-08T00:00:00Z",
  };
}

describe("E2E budget change approval", () => {
  it("preserves the approved delta after formatting and unrelated base reductions", () => {
    const original = e2eBudgetChangeDigest(source, JSON.stringify(changedBudget()));
    const base = JSON.parse(source);
    const head = changedBudget();
    base.limits.direct.expectCalls -= 1;
    head.limits.direct.expectCalls -= 1;
    head.$comment = "Updated explanation";
    expect(e2eBudgetChangeDigest(JSON.stringify(base, null, 2), JSON.stringify(head))).toBe(
      original,
    );
  });

  it("invalidates approval when the assertion increase changes", () => {
    expect(e2eBudgetChangeDigest(source, JSON.stringify(changedBudget(2)))).not.toBe(
      e2eBudgetChangeDigest(source, JSON.stringify(changedBudget(1))),
    );
  });

  it("invalidates approval when the changed assertion moves to another file", () => {
    const head = changedBudget();
    const original = e2eBudgetChangeDigest(source, JSON.stringify(head));
    const [first, second] = Object.keys(head.limits.files);
    head.limits.files[first][1] -= 1;
    head.limits.files[second][1] += 1;
    expect(e2eBudgetChangeDigest(source, JSON.stringify(head))).not.toBe(original);
  });

  it("rejects reference changes and invalid budget metadata", () => {
    const head = changedBudget();
    head.reference.mainSha = "f".repeat(40);
    expect(e2eBudgetChangeDigest(source, JSON.stringify(head))).toBeNull();
    expect(() => e2eBudgetChangeDigest(source, "{}")).toThrow();
  });

  it("binds zero-assertion file inventory changes", () => {
    const head = changedBudget();
    const before = e2eBudgetChangeDigest(source, JSON.stringify(head));
    head.limits.files["test/e2e/live/new.test.ts"] = [0, 0, 0, 0, 0];
    expect(e2eBudgetChangeDigest(source, JSON.stringify(head))).not.toBe(before);
  });

  it("accepts a verified PR record without a prerequisite policy change", async () => {
    const head = JSON.stringify(changedBudget());
    const digest = e2eBudgetChangeDigest(source, head)!;
    const approval = vi.fn(async (value: string) => value === digest);
    const diff = {
      files: [{ filename: BUDGET, status: "modified" }],
      pullRequestNumber: PR,
      exceptionPolicySource: "base" as const,
      readBase: async () => new Map([[BUDGET, source]]),
      readHead: async () => new Map([[BUDGET, head]]),
      readBudgetApproval: approval,
    };
    expect(await e2eAssertionBudgetGrowthViolations(diff)).toEqual([]);
    expect(approval).toHaveBeenCalledWith(digest);
    expect(
      await e2eAssertionBudgetGrowthViolations({ ...diff, readBudgetApproval: async () => false }),
    ).not.toEqual([]);
  });

  it("accepts a trusted delta entry only for its PR and rejects candidate self-authorization", async () => {
    const head = JSON.stringify(changedBudget());
    const policy = JSON.stringify({
      schemaVersion: 1,
      exceptions: [{ pullRequest: PR, changeSha256: e2eBudgetChangeDigest(source, head) }],
    });
    const diff = {
      files: [{ filename: BUDGET, status: "modified" }],
      pullRequestNumber: PR,
      exceptionPolicySource: "base" as const,
      readBase: async () =>
        new Map([
          [BUDGET, source],
          [POLICY, policy],
        ]),
      readHead: async () =>
        new Map([
          [BUDGET, head],
          [POLICY, policy],
        ]),
    };
    expect(await e2eAssertionBudgetGrowthViolations(diff)).toEqual([]);
    expect(
      await e2eAssertionBudgetGrowthViolations({ ...diff, pullRequestNumber: PR + 1 }),
    ).not.toEqual([]);
    expect(
      await e2eAssertionBudgetGrowthViolations({
        ...diff,
        readBase: async () => new Map([[BUDGET, source]]),
      }),
    ).not.toEqual([]);
  });
});

describe("GitHub maintainer budget records", () => {
  it.each(["write", "maintain", "admin", "read", "triage"])(
    "checks the author's %s permission",
    (permission) => {
      const api = vi.fn((endpoint: string) =>
        endpoint.includes("/comments?")
          ? [record()]
          : { permission: permission === "maintain" ? "write" : permission, role_name: permission },
      );
      expect(hasMaintainerBudgetApproval(PR, HASH, api)).toBe(
        ["maintain", "admin"].includes(permission),
      );
      expect(api).toHaveBeenCalledWith(
        `repos/NVIDIA/NemoClaw/issues/${PR}/comments?per_page=100&page=1`,
      );
      expect(api).toHaveBeenCalledWith("repos/NVIDIA/NemoClaw/collaborators/maintainer/permission");
    },
  );

  it.each([
    record("approve", "b".repeat(64)),
    { ...record(), updated_at: "2026-10-08T00:00:01Z" },
    { ...record(), created_at: undefined, updated_at: undefined },
    record("approve", HASH, "maintainer", "Bot"),
    { ...record(), body: `Example:\nNemoClaw-E2E-Growth: approve ${HASH}` },
    { ...record(), body: "```text\n" + record().body + "\n```" },
    record("approve", HASH, "../admin"),
    {
      body: `Quoted: NemoClaw-E2E-Growth: approve ${HASH}`,
      user: { login: "maintainer", type: "User" },
    },
  ])("rejects an ineligible or unrelated record %j", (comment) => {
    const api = vi.fn(() => [comment]);
    expect(hasMaintainerBudgetApproval(PR, HASH, api)).toBe(false);
    expect(api).toHaveBeenCalledTimes(1);
  });

  it("honors a later revocation across pages", () => {
    const page = Array.from({ length: 100 }, () => ({ body: "ordinary comment" }));
    page[0] = record();
    const api = vi.fn((endpoint: string) =>
      endpoint.endsWith("/permission")
        ? { permission: "write", role_name: "maintain" }
        : endpoint.endsWith("page=1")
          ? page
          : [record("revoke")],
    );
    expect(hasMaintainerBudgetApproval(PR, HASH, api)).toBe(false);
  });

  it("rejects missing records and does not let a non-maintainer revoke an approval", () => {
    expect(hasMaintainerBudgetApproval(PR, HASH, () => [])).toBe(false);
    const api = (endpoint: string) =>
      endpoint.includes("/comments?")
        ? [record(), record("revoke", HASH, "reader")]
        : {
            permission: endpoint.includes("/reader/") ? "read" : "write",
            role_name: endpoint.includes("/reader/") ? "read" : "maintain",
          };
    expect(hasMaintainerBudgetApproval(PR, HASH, api)).toBe(true);
  });

  it("fails closed on API errors or malformed responses", () => {
    expect(() =>
      hasMaintainerBudgetApproval(PR, HASH, () => {
        throw new Error("API unavailable");
      }),
    ).toThrow("API unavailable");
    expect(() => hasMaintainerBudgetApproval(PR, HASH, () => null)).toThrow("Could not read");
    expect(() => hasMaintainerBudgetApproval(0, HASH, () => [])).toThrow("Invalid");
  });
});

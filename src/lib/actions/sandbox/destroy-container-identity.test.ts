// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { fingerprintOpenShellSandboxId } from "../../adapters/openshell/sandbox-identity";
import {
  classifyDestroyContainerIdentity,
  type DestroyContainerIdentityVerdict,
  formatAmbiguousDestroyIdentity,
} from "./destroy-presence";

type Row = {
  id: string;
  managedBy?: string;
  workspace?: string;
  sandboxId?: string;
};

function observeRows(rows: Row[], malformedRows = 0) {
  return {
    status: "observed" as const,
    rows: rows.map((row) => ({
      id: row.id,
      managedBy: row.managedBy ?? "",
      workspace: row.workspace ?? "",
      sandboxId: row.sandboxId ?? "",
    })),
    malformedRows,
  };
}

const MANAGED = {
  id: "aaaa000000000000",
  managedBy: "openshell",
  workspace: "default",
  sandboxId: "sb-real",
} as const;

const FOREIGN = {
  id: "ffff000000000000",
  managedBy: "",
  workspace: "foreign",
  sandboxId: "",
} as const;

function expectAmbiguous(
  verdict: DestroyContainerIdentityVerdict,
): Extract<DestroyContainerIdentityVerdict, { status: "ambiguous" }> {
  expect(verdict.status).toBe("ambiguous");
  return verdict as Extract<DestroyContainerIdentityVerdict, { status: "ambiguous" }>;
}

describe("classifyDestroyContainerIdentity", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is clear when no container carries the sandbox-name label", () => {
    expect(classifyDestroyContainerIdentity("destroytest", observeRows([]))).toEqual({
      status: "clear",
      identity: null,
    });
  });

  it("is clear for exactly one managed container", () => {
    expect(classifyDestroyContainerIdentity("destroytest", observeRows([MANAGED]))).toEqual({
      status: "clear",
      identity: MANAGED,
    });
  });

  it("does not treat native Podman ownership as Docker compatibility", () => {
    const podmanManaged = { ...MANAGED, managedBy: "true" };

    expect(
      expectAmbiguous(classifyDestroyContainerIdentity("destroytest", observeRows([podmanManaged])))
        .foreign,
    ).toEqual([podmanManaged]);
  });

  it("refuses when a foreign container shares the sandbox-name label (#8999)", () => {
    // The exact repro: a real managed sandbox plus a busybox that borrows the
    // sandbox-name label with a different workspace and no managed marker.
    const verdict = expectAmbiguous(
      classifyDestroyContainerIdentity("destroytest", observeRows([MANAGED, FOREIGN])),
    );
    expect(verdict.foreign).toHaveLength(1);
    expect(verdict.foreign[0].id).toBe(FOREIGN.id);
    expect(verdict.managed).toHaveLength(1);
    expect(verdict.reason).toContain("managed-by");
  });

  it("refuses a foreign-only match with no managed container behind it", () => {
    const verdict = expectAmbiguous(
      classifyDestroyContainerIdentity("destroytest", observeRows([FOREIGN])),
    );
    expect(verdict.managed).toHaveLength(0);
    expect(verdict.foreign).toHaveLength(1);
  });

  it("refuses when managed containers span more than one workspace", () => {
    const observe = vi.fn(() =>
      observeRows([
        MANAGED,
        {
          id: "bbbb000000000000",
          managedBy: "openshell",
          workspace: "other",
          sandboxId: "sb-real",
        },
      ]),
    );
    const verdict = expectAmbiguous(classifyDestroyContainerIdentity("destroytest", observe()));
    expect(verdict.reason).toContain("2 managed containers");
  });

  it("refuses when managed containers span more than one sandbox-id", () => {
    const observe = vi.fn(() =>
      observeRows([
        MANAGED,
        {
          id: "cccc000000000000",
          managedBy: "openshell",
          workspace: "default",
          sandboxId: "sb-two",
        },
      ]),
    );
    expect(classifyDestroyContainerIdentity("destroytest", observe()).status).toBe("ambiguous");
  });

  it("refuses multiple managed containers even when their mutable labels match", () => {
    const verdict = expectAmbiguous(
      classifyDestroyContainerIdentity(
        "destroytest",
        observeRows([MANAGED, { ...MANAGED, id: "dddd000000000000" }]),
      ),
    );
    expect(verdict.reason).toContain("2 managed containers");
  });

  it("accepts every managed container bound to one retained sandbox identity (#10547)", () => {
    const sandboxIdentityFingerprint = fingerprintOpenShellSandboxId(MANAGED.sandboxId)!;
    const identities = [MANAGED, { ...MANAGED, id: "dddd000000000000" }];

    expect(
      classifyDestroyContainerIdentity(
        "destroytest",
        observeRows(identities),
        sandboxIdentityFingerprint,
      ),
    ).toEqual({ status: "recovery", identities });
  });

  it("refuses a retained recovery set that contains another sandbox identity (#10547)", () => {
    const sandboxIdentityFingerprint = fingerprintOpenShellSandboxId(MANAGED.sandboxId)!;
    const verdict = expectAmbiguous(
      classifyDestroyContainerIdentity(
        "destroytest",
        observeRows([MANAGED, { ...MANAGED, id: "dddd000000000000", sandboxId: "sb-replacement" }]),
        sandboxIdentityFingerprint,
      ),
    );

    expect(verdict.reason).toContain("retained sandbox identity");
  });

  it("accepts one managed container matching the retained identity and refuses a mismatch", () => {
    const sandboxIdentityFingerprint = fingerprintOpenShellSandboxId(MANAGED.sandboxId)!;

    expect(
      classifyDestroyContainerIdentity(
        "destroytest",
        observeRows([MANAGED]),
        sandboxIdentityFingerprint,
      ),
    ).toEqual({ status: "clear", identity: MANAGED });

    const mismatch = expectAmbiguous(
      classifyDestroyContainerIdentity(
        "destroytest",
        observeRows([{ ...MANAGED, sandboxId: "sb-replacement" }]),
        sandboxIdentityFingerprint,
      ),
    );
    expect(mismatch.reason).toContain("retained sandbox identity");
  });

  it("accepts a managed container created without a workspace label", () => {
    const legacyManaged = { ...MANAGED, workspace: "" };

    expect(classifyDestroyContainerIdentity("destroytest", observeRows([legacyManaged]))).toEqual({
      status: "clear",
      identity: legacyManaged,
    });
  });

  it("rejects a same-name container when its ID conflicts with the registered sandbox", () => {
    const registeredFingerprint = fingerprintOpenShellSandboxId(MANAGED.sandboxId)!;
    const differentIdentity = { ...MANAGED, workspace: "", sandboxId: "sb-other" };

    const verdict = expectAmbiguous(
      classifyDestroyContainerIdentity(
        "destroytest",
        observeRows([differentIdentity]),
        undefined,
        registeredFingerprint,
      ),
    );
    expect(verdict.reason).toContain("registered sandbox identity");
    expect(
      classifyDestroyContainerIdentity(
        "destroytest",
        observeRows([{ ...MANAGED, workspace: "" }]),
        undefined,
        registeredFingerprint,
      ).status,
    ).toBe("clear");
  });

  it("accepts a retained recovery set created without workspace labels and rejects mixed workspaces", () => {
    const sandboxIdentityFingerprint = fingerprintOpenShellSandboxId(MANAGED.sandboxId)!;
    const legacyIdentities = [
      { ...MANAGED, workspace: "" },
      { ...MANAGED, id: "dddd000000000000", workspace: "" },
    ];

    expect(
      classifyDestroyContainerIdentity(
        "destroytest",
        observeRows(legacyIdentities),
        sandboxIdentityFingerprint,
      ),
    ).toEqual({ status: "recovery", identities: legacyIdentities });

    const mixedVerdict = expectAmbiguous(
      classifyDestroyContainerIdentity(
        "destroytest",
        observeRows([
          { ...MANAGED, workspace: "" },
          { ...MANAGED, id: "dddd000000000000" },
        ]),
        sandboxIdentityFingerprint,
      ),
    );
    expect(mixedVerdict.reason).toContain("retained sandbox identity");
  });

  it("refuses a managed container with no sandbox ID", () => {
    const verdict = expectAmbiguous(
      classifyDestroyContainerIdentity("destroytest", observeRows([{ ...MANAGED, sandboxId: "" }])),
    );
    expect(verdict.reason).toContain("missing openshell.ai/sandbox-id");
  });

  it("refuses malformed Docker identity output", () => {
    const verdict = expectAmbiguous(
      classifyDestroyContainerIdentity("destroytest", observeRows([], 1)),
    );
    expect(verdict.reason).toContain("malformed container identity");
  });

  it("refuses terminal-control label output without rendering it", () => {
    const verdict = expectAmbiguous(
      classifyDestroyContainerIdentity("destroytest", observeRows([], 1)),
    );
    expect(formatAmbiguousDestroyIdentity(verdict, "nemoclaw").join("\n")).not.toContain("\u001b");
  });

  it("reports a failed Docker probe when identity cannot be proven", () => {
    const verdict = classifyDestroyContainerIdentity("destroytest", {
      status: "probe-failed",
      detail: "Cannot connect to daemon",
    });
    expect(verdict).toEqual({
      status: "probe-failed",
      detail: expect.stringContaining("daemon"),
    });
  });
});

describe("formatAmbiguousDestroyIdentity", () => {
  it("names the refusal, both container roles, and the recovery step", () => {
    const verdict = expectAmbiguous(
      classifyDestroyContainerIdentity("destroytest", observeRows([MANAGED, FOREIGN])),
    );
    const lines = formatAmbiguousDestroyIdentity(verdict, "nemoclaw").join("\n");
    expect(lines).toContain("Refusing to destroy sandbox 'destroytest'");
    expect(lines).toContain("Conflicting container:");
    expect(lines).toContain("Managed sandbox container:");
    expect(lines).toContain('openshell.ai/sandbox-id="sb-real"');
    expect(lines).toContain("Resolve the conflict through the workflow that owns the container");
    expect(lines).toContain("nemoclaw destroytest destroy");
    expect(lines).not.toContain("--yes");
  });

  it("quotes label values so printable delimiters cannot forge adjacent fields", () => {
    const foreign = {
      ...FOREIGN,
      managedBy: 'foreign", openshell.ai/sandbox-workspace="default',
      workspace: 'foo, bar"baz',
      sandboxId: 'sb-foreign", openshell.ai/managed-by="openshell',
    };
    const verdict = expectAmbiguous(
      classifyDestroyContainerIdentity("destroytest", observeRows([MANAGED, foreign])),
    );
    const lines = formatAmbiguousDestroyIdentity(verdict, "nemoclaw").join("\n");
    expect(lines).toContain(`openshell.ai/managed-by=${JSON.stringify(foreign.managedBy)}`);
    expect(lines).toContain(`openshell.ai/sandbox-workspace=${JSON.stringify(foreign.workspace)}`);
    expect(lines).toContain(`openshell.ai/sandbox-id=${JSON.stringify(foreign.sandboxId)}`);
    expect(lines).not.toContain(
      'openshell.ai/managed-by="foreign", openshell.ai/sandbox-workspace="default"',
    );
  });
});

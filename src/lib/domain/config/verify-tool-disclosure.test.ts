// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { exportSnapshots } from "../../actions/config/export-test-fixture";
import { validateNemoClawConfig } from "../../config/schema";
import { buildManagedStartupProfile } from "../../onboard/managed-startup/profile-builder";
import type { SandboxEntry, SandboxWorkloadReceipt } from "../../state/registry/types";
import type { ObservedExportSnapshot, QualifiedExportSnapshot } from "./export-evidence";
import { verifyExportSource } from "./verify-export-source";
import {
  canonicalPolicy,
  imageRef,
  entry,
  managedWorkload,
  profileInput,
  snapshot,
} from "./export-source-test-fixture";

function verifiedSource(result: ReturnType<typeof verifyExportSource>) {
  expect(result.kind).toBe("verified");
  return (result as Extract<typeof result, { kind: "verified" }>).source;
}

function verify(
  value: ObservedExportSnapshot,
  requestedSandboxName = "alpha",
  policyRepresentable = true,
) {
  const identity = { sandboxId: value.policy.sandboxId, revision: value.policy.revision };
  const qualified = {
    ...value,
    policy: policyRepresentable
      ? { ...identity, kind: "verified", canonical: canonicalPolicy }
      : { ...identity, kind: "not-representable" },
  } as QualifiedExportSnapshot;
  return verifyExportSource(requestedSandboxName, qualified);
}

function directToolsSnapshot(overrides: Partial<SandboxEntry> = {}) {
  return snapshot({
    registry: entry({
      toolDisclosure: "direct",
      workload: managedWorkload(
        profileInput({
          toolDisclosure: "direct",
          environment: { NEMOCLAW_TOOL_DISCLOSURE: "direct" },
        }),
      ),
      ...overrides,
    }),
  });
}

describe("managed tool-disclosure export", () => {
  it("exports direct tools when the registry and managed profile agree", async () => {
    const observed = directToolsSnapshot();
    const result = await exportSnapshots([observed]);
    expect(result.outcome).toEqual({ ok: true, completion: { kind: "stdout" } });
    expect(result.read).toHaveBeenCalledTimes(2);
    expect(result.publish).not.toHaveBeenCalled();
    const [yaml] = result.writeStdout.mock.calls[0]!;
    const document = validateNemoClawConfig(YAML.parse(yaml));
    expect(document.spec.sandboxes[0]!.agents[0]!).toHaveProperty("tools", {
      disclosure: "direct",
    });
    expect(document.spec.sandboxes[0]!.network.policy.explicit).toEqual(canonicalPolicy);
    expect(Object.isFrozen(verifiedSource(verify(observed)).tools)).toBe(true);
  });

  it("exports direct tools together with retained managed proxy settings", async () => {
    const result = await exportSnapshots([
      directToolsSnapshot({
        workload: managedWorkload(
          profileInput({
            toolDisclosure: "direct",
            environment: { NEMOCLAW_PROXY_HOST: "proxy.internal", NEMOCLAW_PROXY_PORT: "3129" },
          }),
        ),
      }),
    ]);
    expect(result.outcome).toEqual({ ok: true, completion: { kind: "stdout" } });
    const [yaml] = result.writeStdout.mock.calls[0]!;
    const sandbox = validateNemoClawConfig(YAML.parse(yaml)).spec.sandboxes[0]!;
    expect(sandbox.agents[0]!).toHaveProperty("tools", { disclosure: "direct" });
    expect(sandbox.network.proxy).toEqual({ host: "proxy.internal", port: 3129 });
  });

  it.each([undefined, "progressive"] as const)(
    "omits canonical progressive tools for registry selection %s",
    async (toolDisclosure) => {
      const result = await exportSnapshots([snapshot({ registry: entry({ toolDisclosure }) })]);
      expect(result.outcome.ok).toBe(true);
      const [yaml] = result.writeStdout.mock.calls[0]!;
      expect(
        validateNemoClawConfig(YAML.parse(yaml)).spec.sandboxes[0]!.agents[0],
      ).not.toHaveProperty("tools");
    },
  );

  it.each([
    { label: "absent registry selection", change: { toolDisclosure: undefined } },
    { label: "conflicting registry selection", change: { toolDisclosure: "progressive" as const } },
    { label: "conflicting retained mode", change: { workload: managedWorkload() } },
    { label: "missing workload", change: { workload: undefined } },
    { label: "another agent", change: { agent: "hermes" as const } },
    {
      label: "stale image identity",
      change: { imageTag: imageRef.replace(/a{64}$/, "b".repeat(64)) },
    },
    {
      label: "stale live identity",
      change: { lifecycleLiveIdentityFingerprint: "other-generation" },
    },
    { label: "custom image", change: { fromDockerfile: "/tmp/custom-image" } },
    {
      label: "minimal bootstrap",
      change: {
        workload: managedWorkload(
          profileInput({
            toolDisclosure: "direct",
            environment: { NEMOCLAW_MINIMAL_BOOTSTRAP: "1" },
          }),
        ),
      },
    },
  ])("does not publish direct tools with $label", async ({ change }) => {
    const result = await exportSnapshots([directToolsSnapshot(change)]);
    expect(result.outcome).toMatchObject({ ok: false, failure: { kind: "observation" } });
    expect(result.writeStdout).not.toHaveBeenCalled();
    expect(result.publish).not.toHaveBeenCalled();
  });

  it.each([null, "", "DIRECT", " direct ", "credential-canary", false])(
    "rejects malformed retained registry disclosure without exposing its value",
    async (toolDisclosure) => {
      const result = await exportSnapshots([
        directToolsSnapshot({ toolDisclosure } as unknown as Partial<SandboxEntry>),
      ]);
      expect(result.outcome).toMatchObject({ ok: false, failure: { kind: "observation" } });
      expect(result.writeStdout).not.toHaveBeenCalled();
      expect(result.publish).not.toHaveBeenCalled();
      expect(JSON.stringify(result.outcome)).not.toContain("credential-canary");
    },
  );

  it.each([
    { disclosure: undefined },
    { disclosure: null },
    { disclosure: "credential-canary" },
    { enabledGateways: ["nous-web"] },
    { token: "credential-canary" },
  ])("rejects malformed or unsupported retained tools without output", async (change) => {
    const input = profileInput({ toolDisclosure: "direct" });
    const built = buildManagedStartupProfile(input);
    const canonical = JSON.parse(
      Buffer.from(built.encodedProfile, "base64url").toString("utf8"),
    ) as typeof built.profile;
    const changed = { ...canonical, tools: { ...canonical.tools, ...change } };
    const encodedProfile = Buffer.from(JSON.stringify(changed)).toString("base64url");
    const observed = directToolsSnapshot({
      workload: {
        ...managedWorkload(input),
        encodedProfile,
        startupProfileSha256: createHash("sha256").update(encodedProfile, "utf8").digest("hex"),
      },
    });
    const result = await exportSnapshots([observed]);
    expect(result.outcome).toMatchObject({ ok: false, failure: { kind: "observation" } });
    expect(result.writeStdout).not.toHaveBeenCalled();
    expect(result.publish).not.toHaveBeenCalled();
    expect(JSON.stringify(result.outcome)).not.toContain("credential-canary");
  });

  it.each([{ startupProfileSha256: "f".repeat(64) }, { capabilityContractVersion: 0 }])(
    "retains managed image contract and profile hash checks for direct tools",
    async (change) => {
      const workload = managedWorkload(profileInput({ toolDisclosure: "direct" }));
      const invalid = { ...workload, ...change } as unknown as SandboxWorkloadReceipt;
      const result = await exportSnapshots([directToolsSnapshot({ workload: invalid })]);
      expect(result.outcome.ok).toBe(false);
      expect(result.writeStdout).not.toHaveBeenCalled();
      expect(result.publish).not.toHaveBeenCalled();
    },
  );

  it("reobserves changed tool selection before publishing a stable direct profile", async () => {
    const direct = directToolsSnapshot();
    const result = await exportSnapshots([snapshot(), direct, direct, direct]);
    expect(result.outcome.ok).toBe(true);
    expect(result.read).toHaveBeenCalledTimes(4);
    const [yaml] = result.writeStdout.mock.calls[0]!;
    expect(validateNemoClawConfig(YAML.parse(yaml)).spec.sandboxes[0]!.agents[0]!).toHaveProperty(
      "tools",
      {
        disclosure: "direct",
      },
    );
  });

  it("does not publish when tool selection changes during both observations", async () => {
    const result = await exportSnapshots([
      snapshot(),
      directToolsSnapshot(),
      snapshot(),
      directToolsSnapshot(),
    ]);
    expect(result.outcome).toMatchObject({
      ok: false,
      failure: {
        kind: "observation",
        findings: [expect.objectContaining({ category: "unstable-source" })],
      },
    });
    expect(result.writeStdout).not.toHaveBeenCalled();
    expect(result.publish).not.toHaveBeenCalled();
  });
});

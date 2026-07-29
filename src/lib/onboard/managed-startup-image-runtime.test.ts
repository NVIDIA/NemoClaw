// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, X509Certificate } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  MANAGED_STARTUP_E2E_CORPORATE_CA_PEM,
  managedStartupE2eProfile,
} from "../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import { mapManagedStartupProfileToAgentEnvironment } from "./managed-startup/agent-environment";
import {
  buildManagedStartupImageActionPlan,
  MANAGED_STARTUP_MERGED_CA_FILE,
  serializeManagedStartupRuntimeEnvironment,
} from "./managed-startup/image-runtime";
import {
  fingerprintManagedStartupProfile,
  MANAGED_STARTUP_AGENTS,
  validateManagedStartupProfile,
} from "./managed-startup/profile";

describe("managed startup image runtime", () => {
  it.each(
    MANAGED_STARTUP_AGENTS,
  )("maps the complete %s profile to an offline image-side action plan", (agent) => {
    const profile = managedStartupE2eProfile(agent);
    const mapped = mapManagedStartupProfileToAgentEnvironment(profile);
    const plan = buildManagedStartupImageActionPlan(mapped);

    expect(plan.some((command) => command.argv.includes("agent-install"))).toBe(false);
    expect(
      plan.some((command) =>
        command.argv.some((argument) => /^(?:npm|npx|pip|pip3|uv)$/u.test(argument)),
      ),
    ).toBe(false);

    if (agent === "langchain-deepagents-code") {
      expect(plan).toEqual([
        {
          action: "generate-agent-config",
          runAs: "sandbox",
          argv: [
            "/usr/local/bin/node",
            "--experimental-strip-types",
            "/opt/nemoclaw-deepagents-code/generate-config.ts",
          ],
        },
      ]);
      return;
    }

    expect(plan.map(({ action, runAs }) => ({ action, runAs }))).toEqual([
      { action: "messaging-runtime-setup", runAs: "root" },
      { action: "generate-agent-config", runAs: "sandbox" },
      { action: "messaging-post-agent-install", runAs: "sandbox" },
    ]);
    expect(plan[0]?.argv).toContain("runtime-setup");
    expect(plan[2]?.argv).toContain("post-agent-install");
  });

  it.each(
    MANAGED_STARTUP_AGENTS,
  )("provides valid same-profile and changed-profile fixtures for %s recreation checks", (agent) => {
    const initial = validateManagedStartupProfile(managedStartupE2eProfile(agent));
    const same = validateManagedStartupProfile(managedStartupE2eProfile(agent));
    const changed = validateManagedStartupProfile(managedStartupE2eProfile(agent, true));

    expect(fingerprintManagedStartupProfile(same)).toBe(fingerprintManagedStartupProfile(initial));
    expect(fingerprintManagedStartupProfile(changed)).not.toBe(
      fingerprintManagedStartupProfile(initial),
    );
  });

  it("binds the real corporate-CA fixture into every agent profile by exact digest", () => {
    expect(() => new X509Certificate(MANAGED_STARTUP_E2E_CORPORATE_CA_PEM)).not.toThrow();
    const digest = createHash("sha256").update(MANAGED_STARTUP_E2E_CORPORATE_CA_PEM).digest("hex");

    for (const agent of MANAGED_STARTUP_AGENTS) {
      expect(managedStartupE2eProfile(agent, false, true).corporateCa.bundleSha256).toBe(digest);
    }
  });

  it("writes a deterministic root-sourced runtime environment without profile transport", () => {
    const script = serializeManagedStartupRuntimeEnvironment(
      {
        NEMOCLAW_MODEL: "model-with-'quote",
        NEMOCLAW_OBSERVABILITY: "0",
      },
      true,
      {
        NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
        NEMOCLAW_MODEL: "model-with-'quote",
      },
    );

    expect(script).toContain("unset NEMOCLAW_INFERENCE_BASE_URL");
    expect(script).toContain("export NEMOCLAW_MANAGED_STARTUP_APPLIED='1'");
    expect(script).toContain("export NEMOCLAW_MODEL='model-with-'\"'\"'quote'");
    expect(script).toContain(`export SSL_CERT_FILE='${MANAGED_STARTUP_MERGED_CA_FILE}'`);
    expect(script).toContain("export _NEMOCLAW_CORPORATE_CA_MERGED='1'");
    expect(script).not.toContain("NEMOCLAW_STARTUP_PROFILE_B64");
    expect(script).not.toContain("NEMOCLAW_CORPORATE_CA_B64");
    expect(script.endsWith("\n")).toBe(true);
  });

  it.each(
    MANAGED_STARTUP_AGENTS,
  )("preserves launch-only proxy env for %s unless the agent pins managed routing", (agent) => {
    const mapped = mapManagedStartupProfileToAgentEnvironment(
      managedStartupE2eProfile(agent, false, false, true),
    );
    const script = serializeManagedStartupRuntimeEnvironment(
      mapped.runtimeEnvironment,
      false,
      mapped.configurationEnvironment,
    );
    for (const name of [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "NO_PROXY",
      "http_proxy",
      "https_proxy",
      "no_proxy",
    ]) {
      if (agent === "langchain-deepagents-code") {
        expect(script).toContain(`unset ${name}`);
      } else {
        expect(script).not.toMatch(new RegExp(`(?:export|unset) ${name}(?:=|$)`, "mu"));
      }
    }
  });

  it("rejects multiline runtime values before producing a sourceable file", () => {
    expect(() =>
      serializeManagedStartupRuntimeEnvironment({ NEMOCLAW_MODEL: "bad\nvalue" }, false),
    ).toThrow(/single-line/u);
  });
});

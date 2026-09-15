// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(".", () => ({
  getGatewayPresets: vi.fn(),
  getPresetEndpoints: vi.fn(),
  listCustomPresets: vi.fn(),
  listPresets: vi.fn(),
  loadPresetForSandbox: vi.fn(),
}));

import * as policies from ".";
import { buildPolicyContext, renderPolicyContextMarkdown } from "./context";

beforeEach(() => {
  vi.mocked(policies.listPresets).mockReturnValue([
    { file: "npm.yaml", name: "npm", description: "npm registry" },
    { file: "github.yaml", name: "github", description: "GitHub API" },
  ]);
  vi.mocked(policies.listCustomPresets).mockResolvedValue([]);
  vi.mocked(policies.loadPresetForSandbox).mockImplementation(
    async (_sandbox, name) =>
      `preset:\n  name: ${name}\nnetwork_policies:\n  ${name}:\n    endpoints:\n      - host: ${name}.example.com\n`,
  );
  vi.mocked(policies.getPresetEndpoints).mockImplementation((content) => {
    const match = /host:\s*(\S+)/u.exec(content);
    return match ? [match[1]] : [];
  });
});

describe("policy context", () => {
  it("derives active and inactive presets only from the live OpenShell view", async () => {
    vi.mocked(policies.getGatewayPresets).mockResolvedValue(["npm"]);
    const context = await buildPolicyContext("alpha");
    expect(context.activePresets).toEqual([
      expect.objectContaining({ name: "npm", verification: "verified" }),
    ]);
    expect(context.knownUnappliedPresets).toEqual([
      expect.objectContaining({ name: "github", verification: "gateway-unavailable" }),
    ]);
    expect(context).not.toHaveProperty("baselineExclusions");
  });

  it("reports an unavailable gateway without falling back to registry state", async () => {
    vi.mocked(policies.getGatewayPresets).mockResolvedValue(null);
    const context = await buildPolicyContext("alpha");
    expect(context.activePresets).toEqual([]);
    expect(context.knownUnappliedPresets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "npm", verification: "gateway-unavailable" }),
      ]),
    );
  });

  it("describes OpenShell as the enforcement owner", async () => {
    vi.mocked(policies.getGatewayPresets).mockResolvedValue(["npm"]);
    expect(renderPolicyContextMarkdown(await buildPolicyContext("alpha"))).toContain(
      "policy is enforced by the OpenShell gateway",
    );
  });

  it("includes live custom presets as active without a registry activation list", async () => {
    vi.mocked(policies.listCustomPresets).mockResolvedValue([
      { file: "corp.yaml", name: "corp", description: "Corporate API" },
    ]);
    vi.mocked(policies.getGatewayPresets).mockResolvedValue(["corp"]);
    const context = await buildPolicyContext("alpha");
    expect(context.activePresets).toContainEqual(
      expect.objectContaining({ name: "corp", source: "custom", verification: "verified" }),
    );
  });

  it("redacts private and internal hosts while retaining public host stems", async () => {
    vi.mocked(policies.getGatewayPresets).mockResolvedValue(["npm"]);
    vi.mocked(policies.getPresetEndpoints).mockReturnValue([
      "registry.npmjs.org",
      "10.20.30.40",
      "metadata.google.internal",
    ]);
    const [active] = (await buildPolicyContext("alpha")).activePresets;
    expect(active.allowedHostCategories).toEqual(["registry.npmjs.org"]);
    expect(active.redactedHostCount).toBe(2);
  });

  it("skips the live OpenShell probe when requested", async () => {
    const gatewayProbe = vi.mocked(policies.getGatewayPresets);
    const context = await buildPolicyContext("alpha", { skipGatewayProbe: true });
    expect(gatewayProbe).not.toHaveBeenCalled();
    expect(context.activePresets).toEqual([]);
    expect(context.knownUnappliedPresets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "npm", verification: "gateway-unavailable" }),
      ]),
    );
  });

  it("renders a redacted summary and preserves the convenience command surface", async () => {
    vi.mocked(policies.getGatewayPresets).mockResolvedValue(["npm"]);
    vi.mocked(policies.getPresetEndpoints).mockReturnValue(["registry.npmjs.org", "10.20.30.40"]);
    const markdown = renderPolicyContextMarkdown(await buildPolicyContext("alpha"));
    expect(markdown).toContain("npmjs.org");
    expect(markdown).not.toContain("10.20.30.40");
    expect(markdown).toContain("nemoclaw alpha policy add <preset>");
    expect(markdown).toContain("nemoclaw alpha policy remove <preset>");
    expect(markdown).not.toContain("network_policies:");
  });
});

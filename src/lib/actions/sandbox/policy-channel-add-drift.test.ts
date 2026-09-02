// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Drift-aware `policy-add <preset>` contract (#7323): naming an
 * already-applied preset must compare the preset content against the live
 * gateway policy instead of failing on the registry name alone. Users who
 * edit a preset file in place (for example to add `tls: skip` endpoints)
 * previously had their change silently ignored until they ran policy-remove
 * followed by policy-add.
 *
 * - live policy still matches the preset -> successful idempotent no-op
 * - preset content drifted from the live policy -> re-apply (fresh-add path,
 *   including the dry-run preview and interactive confirmation)
 * - preset recorded but absent from the live policy -> re-apply
 * - name owned by a custom (--from-file) preset -> refuse; the built-in
 *   content is the wrong comparison baseline and re-applying it would
 *   clobber the custom policy
 * - preset content or live policy unreadable -> conservative failure
 *   because drift cannot be verified
 */

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import YAML from "yaml";

import { CLI_NAME } from "../../cli/branding";
import * as store from "../../credentials/store";
import { loadMessagingChannelPolicyPreset } from "../../messaging/channels";
import * as policies from "../../policy";
import * as onboardSession from "../../state/onboard-session";
import * as registry from "../../state/registry";
import { addSandboxPolicy } from "./policy-channel";
import * as policyContextRefresh from "./policy-context-refresh";

type PresetInfo = ReturnType<typeof policies.listPresets>[number];

class ExitError extends Error {
  constructor(public readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

const POLICY_PRESETS: PresetInfo[] = [
  { file: "pypi.yaml", name: "pypi", description: "Python Package Index access" },
];

let logSpy: MockInstance;
let errSpy: MockInstance;
let promptSpy: MockInstance;
let applyPresetMock: MockInstance;
let loadPresetForSandboxMock: MockInstance;
let gatewayStateMock: MockInstance;
let npmCompatibilityStateMock: MockInstance;
let refreshSpy: MockInstance;
let stdinIsTty: PropertyDescriptor | undefined;

async function captureExit(action: () => Promise<void>): Promise<number | undefined> {
  const outcome: unknown = await action().then(
    () => new Error("Expected process.exit to be called"),
    (error: unknown) => error,
  );
  expect(outcome).toBeInstanceOf(ExitError);
  return (outcome as ExitError).code;
}

beforeEach(() => {
  delete process.env.NEMOCLAW_NON_INTERACTIVE;
  stdinIsTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });

  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitError(code);
  }) as never);

  promptSpy = vi.spyOn(store, "prompt").mockResolvedValue("y");
  vi.spyOn(registry, "getSandbox").mockReturnValue({
    name: "alpha",
    agent: null,
  });

  vi.spyOn(onboardSession, "loadSession").mockReturnValue(null);
  vi.spyOn(onboardSession, "updateSession").mockReturnValue(
    undefined as unknown as onboardSession.Session,
  );

  vi.spyOn(policies, "listPresets").mockReturnValue(POLICY_PRESETS);
  vi.spyOn(policies, "listCustomPresets").mockReturnValue([]);
  vi.spyOn(policies, "getAppliedPresets").mockReturnValue(["pypi"]);
  loadPresetForSandboxMock = vi.spyOn(policies, "loadPresetForSandbox").mockImplementation(
    (_sandboxName: unknown, name: unknown) =>
      `network_policies:\n  ${String(name)}:\n    host: ${String(name)}.example.com\n`,
  );
  applyPresetMock = vi.spyOn(policies, "applyPreset").mockReturnValue(true);
  gatewayStateMock = vi.spyOn(policies, "getPresetContentGatewayState").mockReturnValue("drift");
  npmCompatibilityStateMock = vi
    .spyOn(policies, "getOpenClawNpmCompatibilityState")
    .mockReturnValue("match");
  vi.spyOn(policies, "getPresetEndpoints").mockReturnValue(["pypi.example.com"]);
  vi.spyOn(policies, "getPresetValidationWarning").mockReturnValue(null);

  refreshSpy = vi
    .spyOn(policyContextRefresh, "refreshSandboxPolicyContextFile")
    .mockReturnValue({ outcome: "ok", written: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.NEMOCLAW_NON_INTERACTIVE;
  stdinIsTty
    ? Object.defineProperty(process.stdin, "isTTY", stdinIsTty)
    : Reflect.deleteProperty(process.stdin, "isTTY");
});

describe("addSandboxPolicy drift-aware named re-add", () => {
  it("re-applies a named preset whose content drifted from the live policy", async () => {
    gatewayStateMock.mockReturnValue("drift");

    await addSandboxPolicy("alpha", { preset: "pypi", yes: true });

    expect(gatewayStateMock).toHaveBeenCalledWith(
      "alpha",
      expect.stringContaining("pypi.example.com"),
    );
    expect(logSpy).toHaveBeenCalledWith("  Preset 'pypi' no longer matches the live policy.");
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "Effective egress scope that would replace the current preset policy",
      ),
    );
    expect(applyPresetMock).toHaveBeenCalledWith("alpha", "pypi", { suppressDisclosure: true });
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(refreshSpy).toHaveBeenCalledWith("alpha");
  });

  it("preserves the stored exact WeChat IDC endpoint during a named drift reapply (#10606)", async () => {
    const idcBaseUrl = "https://idc-37.weixin.qq.com";
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "alpha",
      agent: "openclaw",
      messaging: {
        schemaVersion: 1,
        plan: {
          schemaVersion: 1,
          sandboxName: "alpha",
          agent: "openclaw",
          workflow: "rebuild",
          channels: [
            {
              channelId: "wechat",
              active: true,
              configured: true,
              disabled: false,
              inputs: [
                { inputId: "botToken", credentialAvailable: true },
                { inputId: "accountId", value: "wechat-account" },
                { inputId: "baseUrl", value: idcBaseUrl },
                { inputId: "userId", value: "wechat-user" },
              ],
            },
          ],
          disabledChannels: [],
          credentialBindings: [
            {
              channelId: "wechat",
              providerEnvKey: "WECHAT_BOT_TOKEN",
              credentialAvailable: true,
            },
          ],
        } as never,
      },
    });
    vi.spyOn(policies, "listPresets").mockReturnValue([
      { file: "wechat/policy/openclaw.yaml", name: "wechat", description: "WeChat" },
    ]);
    vi.spyOn(policies, "getAppliedPresets").mockReturnValue(["wechat"]);
    loadPresetForSandboxMock.mockRestore();
    let appliedPolicy: string | null = null;
    applyPresetMock.mockImplementation(
      (_sandboxName: unknown, presetName: unknown, options: unknown) => {
        appliedPolicy = loadMessagingChannelPolicyPreset(String(presetName), {
          agent: "openclaw",
          sandboxName: "alpha",
          messagingConfig: (
            options as { messagingConfig?: Readonly<Record<string, string>> }
          ).messagingConfig,
        });
        return appliedPolicy !== null;
      },
    );

    await addSandboxPolicy("alpha", { preset: "wechat", yes: true });

    const endpoints = YAML.parse(appliedPolicy ?? "").network_policies.wechat_bridge.endpoints;
    expect(
      endpoints.find((endpoint: { host: string }) => endpoint.host === "idc-37.weixin.qq.com"),
    ).toEqual({
      host: "idc-37.weixin.qq.com",
      port: 443,
      protocol: "rest",
      enforcement: "enforce",
      credential_binding: { provider: "alpha-wechat-bridge" },
      rules: [
        { allow: { method: "GET", path: "/**" } },
        { allow: { method: "POST", path: "/**" } },
      ],
    });
    expect(endpoints.map((endpoint: { host: string }) => endpoint.host)).not.toContain(
      "*.weixin.qq.com",
    );
  });

  it("treats a matching named re-add as a successful no-op instead of a failure", async () => {
    gatewayStateMock.mockReturnValue("match");

    await addSandboxPolicy("alpha", { preset: "pypi", yes: true });

    expect(logSpy).toHaveBeenCalledWith(
      "  Preset 'pypi' is already applied and matches the live policy; nothing to do.",
    );
    expect(applyPresetMock).not.toHaveBeenCalled();
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it("repairs a matching npm preset whose OpenClaw compatibility overlay is absent (#8497)", async () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "alpha",
      agent: "openclaw",
    });
    vi.spyOn(policies, "listPresets").mockReturnValue([
      { file: "npm.yaml", name: "npm", description: "npm registry access" },
    ]);
    vi.spyOn(policies, "getAppliedPresets").mockReturnValue(["npm"]);
    vi.spyOn(policies, "loadPresetForSandbox").mockReturnValue(
      "network_policies:\n  npm_yarn:\n    name: npm_yarn\n",
    );
    const disclosureSpy = vi
      .spyOn(policies, "logOpenClawNpmCompatibilityDisclosure")
      .mockImplementation(() => undefined);
    gatewayStateMock.mockReturnValue("match");
    npmCompatibilityStateMock.mockReturnValue("repair");

    await addSandboxPolicy("alpha", { preset: "npm", yes: true });

    expect(logSpy).toHaveBeenCalledWith(
      "  Preset 'npm' matches the live policy, but its OpenClaw compatibility overlay requires repair.",
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "Effective egress scope that would replace the current preset policy",
      ),
    );
    expect(disclosureSpy).toHaveBeenCalledTimes(1);
    expect(applyPresetMock).toHaveBeenCalledWith("alpha", "npm", {
      suppressDisclosure: true,
    });
    expect(refreshSpy).toHaveBeenCalledTimes(1);
  });

  it("re-applies when the preset is recorded but its entries are absent from the live policy", async () => {
    gatewayStateMock.mockReturnValue("absent");

    await addSandboxPolicy("alpha", { preset: "pypi", yes: true });

    expect(logSpy).toHaveBeenCalledWith(
      "  Preset 'pypi' is recorded as applied but missing from the live policy.",
    );
    expect(applyPresetMock).toHaveBeenCalledWith("alpha", "pypi", { suppressDisclosure: true });
    expect(refreshSpy).toHaveBeenCalledTimes(1);
  });

  it("previews a drift re-apply without mutating on --dry-run", async () => {
    gatewayStateMock.mockReturnValue("drift");

    await addSandboxPolicy("alpha", { preset: "pypi", yes: true, dryRun: true });

    expect(gatewayStateMock).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith("  Preset 'pypi' no longer matches the live policy.");
    expect(applyPresetMock).not.toHaveBeenCalled();
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it("asks for confirmation before a drift re-apply and honors decline", async () => {
    promptSpy.mockResolvedValue("n");
    gatewayStateMock.mockReturnValue("drift");

    await addSandboxPolicy("alpha", { preset: "pypi" });

    expect(promptSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith("  Preset 'pypi' no longer matches the live policy.");
    expect(applyPresetMock).not.toHaveBeenCalled();
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it("re-applies drift without prompting when NEMOCLAW_NON_INTERACTIVE=1", async () => {
    process.env.NEMOCLAW_NON_INTERACTIVE = "1";
    gatewayStateMock.mockReturnValue("drift");

    await addSandboxPolicy("alpha", { preset: "pypi" });

    expect(promptSpy).not.toHaveBeenCalled();
    expect(applyPresetMock).toHaveBeenCalledWith("alpha", "pypi", { suppressDisclosure: true });
    expect(refreshSpy).toHaveBeenCalledTimes(1);
  });

  it("fails without an already-applied claim when the preset content cannot be read", async () => {
    vi.spyOn(policies, "loadPresetForSandbox").mockReturnValue(null);

    await expect(
      captureExit(() => addSandboxPolicy("alpha", { preset: "pypi", yes: true })),
    ).resolves.toBe(1);

    expect(errSpy).toHaveBeenCalledWith("  Could not read the content of preset 'pypi'.");
    expect(errSpy).not.toHaveBeenCalledWith(expect.stringContaining("already applied"));
    expect(gatewayStateMock).not.toHaveBeenCalled();
    expect(applyPresetMock).not.toHaveBeenCalled();
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it("keeps the already-applied failure when the live policy cannot be read", async () => {
    gatewayStateMock.mockReturnValue(null);

    await expect(
      captureExit(() => addSandboxPolicy("alpha", { preset: "pypi", yes: true })),
    ).resolves.toBe(1);

    expect(errSpy).toHaveBeenCalledWith("  Preset 'pypi' is already applied.");
    expect(errSpy).toHaveBeenCalledWith(
      "  Could not read the live sandbox policy to compare (is the sandbox gateway running?).",
    );
    expect(errSpy).not.toHaveBeenCalledWith(expect.stringContaining("policy remove"));
    expect(applyPresetMock).not.toHaveBeenCalled();
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it("does not classify drift for a preset that is not applied yet", async () => {
    vi.spyOn(policies, "getAppliedPresets").mockReturnValue([]);

    await addSandboxPolicy("alpha", { preset: "pypi", yes: true });

    expect(gatewayStateMock).not.toHaveBeenCalled();
    expect(applyPresetMock).toHaveBeenCalledWith("alpha", "pypi", { suppressDisclosure: true });
    expect(refreshSpy).toHaveBeenCalledTimes(1);
  });
});

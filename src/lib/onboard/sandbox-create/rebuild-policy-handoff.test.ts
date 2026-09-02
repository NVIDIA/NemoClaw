// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadMessagingChannelPolicyPreset } from "../../messaging";
import { getMessagingPolicyKeysByChannel } from "../../messaging/channels";
import * as policies from "../../policy";
import { getCredentialBindingProviders } from "../initial-policy";
import { allMessagingChannelPolicyPresets } from "../messaging-policy-presets";
import {
  materializeRebuildPolicyHandoff,
  mergeReplacementPolicyAccess,
} from "./rebuild-policy-handoff";

const roots: string[] = [];

function tempPolicy(name: string, source: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-rebuild-handoff-test-"));
  roots.push(root);
  const policyPath = path.join(root, name);
  fs.writeFileSync(policyPath, source, { mode: 0o600 });
  return policyPath;
}

function readPrivatePolicy(policyPath: string): { mode: number; policy: unknown } {
  const descriptor = fs.openSync(
    policyPath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    return {
      mode: fs.fstatSync(descriptor).mode & 0o777,
      policy: YAML.parse(fs.readFileSync(descriptor, "utf8")),
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("rebuild policy handoff", () => {
  it("adds missing replacement access while preserving OpenShell's live choices", () => {
    const live = `
version: 1
filesystem_policy:
  include_workdir: false
  read_only: [/usr, /host-read]
  read_write: [/sandbox, /host-write, /replacement-write]
landlock:
  compatibility: host_choice
network_policies:
  host_edit:
    name: host_edit
    endpoints: [{host: host.example.com, port: 443}]
  host_npm_alias:
    name: npm
    endpoints: [{host: host-npm.example.com, port: 443}]
`;
    const replacement = `
version: 1
filesystem_policy:
  include_workdir: true
  read_only: [/usr, /replacement-read, /replacement-write]
  read_write: [/sandbox, /host-read]
process:
  run_as_user: sandbox
  run_as_group: sandbox
network_policies:
  host_edit:
    name: host_edit
    endpoints: [{host: replacement-host.example.com, port: 443}]
  npm:
    name: npm
    endpoints: [{host: registry.npmjs.org, port: 443}]
  replacement_network:
    name: replacement_network
    endpoints: [{host: replacement.example.com, port: 443}]
landlock:
  compatibility: replacement_choice
seccomp:
  profile: replacement-default
`;

    const merged = mergeReplacementPolicyAccess(live, replacement);
    const policy = YAML.parse(merged.source) as {
      filesystem_policy: { include_workdir: boolean; read_only: string[]; read_write: string[] };
      network_policies: Record<string, unknown>;
      process: { run_as_user: string; run_as_group: string };
    };

    expect(merged.changed).toBe(true);
    expect(policy.filesystem_policy).toEqual({
      include_workdir: false,
      read_only: ["/usr", "/replacement-read"],
      read_write: ["/sandbox", "/host-write", "/replacement-write", "/host-read"],
    });
    expect(policy.process).toEqual({ run_as_user: "sandbox", run_as_group: "sandbox" });
    expect(policy).toMatchObject({
      landlock: { compatibility: "host_choice" },
    });
    expect(policy.network_policies).toEqual({
      host_edit: {
        name: "host_edit",
        endpoints: [{ host: "host.example.com", port: 443 }],
      },
      host_npm_alias: {
        name: "npm",
        endpoints: [{ host: "host-npm.example.com", port: 443 }],
      },
    });
    expect(policy.network_policies).not.toHaveProperty("npm");
    expect(policy).not.toHaveProperty("seccomp");
  });

  it("reuses the exact live source when the replacement needs no additional access", () => {
    const live = "version: 1\nfilesystem_policy:\n  read_only: [/usr]\n  read_write: [/sandbox]\n";
    expect(mergeReplacementPolicyAccess(live, live)).toEqual({
      changed: false,
      source: live,
    });
  });

  it("fills only missing replacement process identity fields", () => {
    const merged = mergeReplacementPolicyAccess(
      "version: 1\nprocess:\n  run_as_user: operator\n",
      "version: 1\nprocess:\n  run_as_user: sandbox\n  run_as_group: sandbox\n",
    );

    expect(YAML.parse(merged.source).process).toEqual({
      run_as_user: "operator",
      run_as_group: "sandbox",
    });
  });

  it("preserves live network policy when no filesystem change is needed", () => {
    const live = "version: 1\nnetwork_policies:\n  host_edit: {name: host_edit}\n";
    const replacement =
      "version: 1\nnetwork_policies:\n  managed_inference: {name: managed_inference}\n";
    expect(mergeReplacementPolicyAccess(live, replacement)).toEqual({
      changed: false,
      source: live,
    });
  });

  it("rejects an incompatible live collision on an explicitly required messaging key", () => {
    const live = `
version: 1
network_policies:
  host_edit: {name: host_edit}
  teams: {name: host_teams}
`;
    const replacement = `
version: 1
network_policies:
  teams: {name: generated_teams}
  wechat: {name: generated_wechat}
  unrelated: {name: unrelated}
`;

    expect(() => mergeReplacementPolicyAccess(live, replacement, ["teams", "wechat"])).toThrow(
      "live network policy 'teams' does not match the enabled channel requirement",
    );
  });

  it("accepts a matching enabled-channel entry and preserves unrelated host policy", () => {
    const live = `version: 1
network_policies:
  host_edit: {name: host_edit}
  teams: {name: generated_teams}
`;
    const replacement = `version: 1
network_policies:
  teams: {name: generated_teams}
`;

    expect(mergeReplacementPolicyAccess(live, replacement, ["teams"])).toEqual({
      changed: false,
      source: live,
    });
  });

  it("upgrades a legacy WeChat policy with only its reviewed exact IDC endpoint (#10606)", () => {
    const legacy = `version: 1
network_policies:
  wechat_bridge:
    name: wechat_bridge
    endpoints:
      - host: ilinkai.wechat.com
        port: 443
        protocol: rest
        credential_binding: {provider: alpha-wechat-bridge}
        rules: [{allow: {method: POST, path: "/**"}}]
    binaries: [{path: /usr/local/bin/node}]
`;
    const replacement = `version: 1
network_policies:
  wechat_bridge:
    name: wechat_bridge
    endpoints:
      - host: ilinkai.wechat.com
        port: 443
        protocol: rest
        credential_binding: {provider: alpha-wechat-bridge}
        rules: [{allow: {method: POST, path: "/**"}}]
      - host: idc-37.weixin.qq.com
        port: 443
        protocol: rest
        credential_binding: {provider: alpha-wechat-bridge}
        rules: [{allow: {method: POST, path: "/**"}}]
    binaries: [{path: /usr/local/bin/node}]
`;

    const merged = mergeReplacementPolicyAccess(legacy, replacement, ["wechat_bridge"]);
    const policy = YAML.parse(merged.source) as {
      network_policies: { wechat_bridge: { endpoints: Array<{ host: string }> } };
    };

    expect(merged.changed).toBe(true);
    expect(policy.network_policies.wechat_bridge.endpoints.map(({ host }) => host)).toEqual([
      "ilinkai.wechat.com",
      "idc-37.weixin.qq.com",
    ]);
  });

  it("replaces one reviewed WeChat IDC endpoint with the current saved endpoint (#10606)", () => {
    const sandboxName = "wechat-idc-rotation";
    const loadPolicy = (host: string) =>
      loadMessagingChannelPolicyPreset("wechat", {
        agent: "openclaw",
        sandboxName,
        messagingConfig: { WECHAT_BASE_URL: `https://${host}` },
      });
    const live = loadPolicy("idc-3.weixin.qq.com");
    const replacement = loadPolicy("idc-37.weixin.qq.com");
    expect(live).not.toBeNull();
    expect(replacement).not.toBeNull();

    const merged = mergeReplacementPolicyAccess(live!, replacement!, ["wechat_bridge"]);
    const policy = YAML.parse(merged.source) as {
      network_policies: { wechat_bridge: { endpoints: Array<{ host: string }> } };
    };

    expect(merged.changed).toBe(true);
    expect(
      policy.network_policies.wechat_bridge.endpoints
        .map(({ host }) => host)
        .filter((host) => host.startsWith("idc-")),
    ).toEqual(["idc-37.weixin.qq.com"]);
  });

  it("rejects a WeChat IDC migration that changes the reviewed endpoint grant (#10606)", () => {
    const legacy = `version: 1
network_policies:
  wechat_bridge:
    endpoints:
      - host: ilinkai.wechat.com
        port: 443
        credential_binding: {provider: alpha-wechat-bridge}
`;
    const widened = `version: 1
network_policies:
  wechat_bridge:
    endpoints:
      - host: ilinkai.wechat.com
        port: 443
        credential_binding: {provider: alpha-wechat-bridge}
      - host: idc-37.weixin.qq.com
        port: 80
        credential_binding: {provider: alpha-wechat-bridge}
`;

    expect(() => mergeReplacementPolicyAccess(legacy, widened, ["wechat_bridge"])).toThrow(
      "does not match the enabled channel requirement",
    );
  });

  it("rejects an active messaging requirement missing from the replacement policy", () => {
    expect(() =>
      mergeReplacementPolicyAccess(
        "version: 1\nnetwork_policies: {}\n",
        "version: 1\nnetwork_policies: {}\n",
        ["wechat"],
      ),
    ).toThrow("required network policy 'wechat' is absent");
  });

  it("removes only the policy keys requested by an explicit stopped channel", () => {
    const live = `
version: 1
network_policies:
  host_edit: {name: host_edit}
  telegram: {name: telegram}
  teams: {name: teams}
`;

    const merged = mergeReplacementPolicyAccess(
      live,
      "version: 1\nnetwork_policies: {}\n",
      [],
      ["telegram"],
    );

    expect(merged.changed).toBe(true);
    expect(YAML.parse(merged.source).network_policies).toEqual({
      host_edit: { name: "host_edit" },
      teams: { name: "teams" },
    });
  });

  it("adds the explicit rebuild observability policy while preserving host entries", () => {
    const merged = mergeReplacementPolicyAccess(
      "version: 1\nnetwork_policies:\n  host_edit: {name: host_edit}\n",
      `version: 1
network_policies:
  observability-otlp-local:
    name: observability-otlp-local
    endpoints: [{host: host.openshell.internal, port: 4318}]
`,
      ["observability-otlp-local"],
    );

    expect(YAML.parse(merged.source).network_policies).toEqual({
      host_edit: { name: "host_edit" },
      "observability-otlp-local": {
        name: "observability-otlp-local",
        endpoints: [{ host: "host.openshell.internal", port: 4318 }],
      },
    });
  });

  it("removes only the explicit rebuild observability policy", () => {
    const merged = mergeReplacementPolicyAccess(
      `version: 1
network_policies:
  host_edit: {name: host_edit}
  observability-otlp-local: {name: observability-otlp-local}
`,
      "version: 1\nnetwork_policies: {}\n",
      [],
      ["observability-otlp-local"],
    );

    expect(YAML.parse(merged.source).network_policies).toEqual({
      host_edit: { name: "host_edit" },
    });
  });

  it("rejects contradictory messaging policy deltas", () => {
    expect(() =>
      mergeReplacementPolicyAccess(
        "version: 1\nnetwork_policies: {}\n",
        "version: 1\nnetwork_policies:\n  telegram: {}\n",
        ["telegram"],
        ["telegram"],
      ),
    ).toThrow("network policy 'telegram' is both required and removed");
  });

  it("uses active channel preset sources without copying unrequested keys", () => {
    const merged = mergeReplacementPolicyAccess(
      "version: 1\nnetwork_policies:\n  host_edit: {}\n  googlechat_hermes: {name: googlechat_hermes}\n",
      "version: 1\nnetwork_policies:\n  googlechat_hermes: {name: generic_googlechat}\n",
      ["googlechat_hermes"],
      [],
      [
        `preset: {name: googlechat}
network_policies:
  googlechat_hermes: {name: googlechat_hermes}
  unrequested: {name: unrequested}
`,
      ],
    );

    expect(YAML.parse(merged.source).network_policies).toEqual({
      host_edit: {},
      googlechat_hermes: { name: "googlechat_hermes" },
    });
  });

  it("rejects conflicting active channel sources for one required policy key", () => {
    expect(() =>
      mergeReplacementPolicyAccess(
        "version: 1\nnetwork_policies: {}\n",
        "version: 1\nnetwork_policies: {}\n",
        ["slack"],
        [],
        [
          "version: 1\nnetwork_policies:\n  slack: {name: slack_a}\n",
          "version: 1\nnetwork_policies:\n  slack: {name: slack_b}\n",
        ],
      ),
    ).toThrow("required network policy 'slack' has conflicting replacement sources");
  });

  it("materializes one private handoff and cleans it with the generated replacement source", () => {
    const livePath = tempPolicy(
      "live.yaml",
      "version: 1\nfilesystem_policy:\n  read_only: [/usr]\n  read_write: [/sandbox]\nnetwork_policies:\n  host_edit: {}\n",
    );
    const replacementPath = tempPolicy(
      "replacement.yaml",
      "version: 1\nfilesystem_policy:\n  read_only: [/usr, /run/replacement]\n  read_write: [/sandbox]\nnetwork_policies:\n  replacement: {}\n",
    );
    const cleanupReplacement = vi.fn(() => true);

    const handoff = materializeRebuildPolicyHandoff({
      livePolicyPath: livePath,
      replacementPolicy: {
        policyPath: replacementPath,
        appliedPresets: ["replacement"],
        cleanup: cleanupReplacement,
      },
    });

    expect(handoff.policyPath).not.toBe(livePath);
    const materialized = readPrivatePolicy(handoff.policyPath);
    expect(materialized.mode).toBe(0o600);
    expect(materialized.policy).toMatchObject({
      filesystem_policy: { read_only: ["/usr", "/run/replacement"] },
      network_policies: { host_edit: {} },
    });
    expect(materialized.policy).not.toMatchObject({ network_policies: { replacement: {} } });
    expect(handoff.appliedPresets).toEqual([]);
    expect(handoff.cleanup?.()).toBe(true);
    expect(cleanupReplacement).toHaveBeenCalledOnce();
    expect(fs.existsSync(handoff.policyPath)).toBe(false);
    expect(fs.existsSync(livePath)).toBe(true);
  });

  it("rejects live credential bindings outside the verified replacement plan", () => {
    const livePath = tempPolicy(
      "live-provider.yaml",
      `version: 1
network_policies:
  planned:
    endpoints:
      - credential_binding: {provider: planned-provider}
  host_added:
    endpoints:
      - credential_binding: {provider: host-added-provider}
`,
    );
    const replacementPath = tempPolicy(
      "replacement-provider.yaml",
      `version: 1
network_policies:
  planned:
    endpoints:
      - credential_binding: {provider: planned-provider}
`,
    );

    expect(() =>
      materializeRebuildPolicyHandoff({
        livePolicyPath: livePath,
        replacementPolicy: {
          policyPath: replacementPath,
          appliedPresets: [],
          credentialBindingProviders: ["planned-provider"],
        },
      }),
    ).toThrow("outside the verified replacement plan");

    const authorized = materializeRebuildPolicyHandoff({
      livePolicyPath: livePath,
      replacementPolicy: {
        policyPath: replacementPath,
        appliedPresets: [],
        credentialBindingProviders: ["planned-provider"],
      },
      authorizedCredentialBindingProviders: ["host-added-provider"],
    });
    expect(authorized.credentialBindingProviders).toEqual([
      "planned-provider",
      "host-added-provider",
    ]);
  });

  it("drops OpenShell provider-composed entries before rebuild authorization", () => {
    const livePath = tempPolicy(
      "live-provider-composed.yaml",
      `version: 1
network_policies:
  host_edit: {name: host_edit}
  _provider_disabled_channel:
    endpoints:
      - credential_binding: {provider: disabled-channel-provider}
`,
    );
    const replacementPath = tempPolicy(
      "replacement-provider-composed.yaml",
      "version: 1\nnetwork_policies: {}\n",
    );

    const handoff = materializeRebuildPolicyHandoff({
      livePolicyPath: livePath,
      replacementPolicy: {
        policyPath: replacementPath,
        appliedPresets: [],
      },
    });

    expect(YAML.parse(fs.readFileSync(handoff.policyPath, "utf8")).network_policies).toEqual({
      host_edit: { name: "host_edit" },
    });
    expect(handoff.credentialBindingProviders).toEqual([]);
    expect(handoff.cleanup?.()).toBe(true);
  });

  it("removes the Teams-owned Outlook login binding when Teams is disabled", () => {
    const merged = mergeReplacementPolicyAccess(
      `version: 1
network_policies:
  teams:
    endpoints:
      - host: login.microsoftonline.com
        port: 443
        credential_binding: {provider: alpha-teams-bridge}
  outlook_graph:
    endpoints:
      - host: login.microsoftonline.com
        port: 443
        credential_binding: {provider: alpha-teams-bridge}
`,
      `version: 1
network_policies:
  outlook_graph:
    endpoints:
      - host: login.microsoftonline.com
        port: 443
`,
      [],
      ["teams"],
      [],
      "alpha",
    );

    expect(YAML.parse(merged.source).network_policies).toEqual({
      outlook_graph: {
        endpoints: [{ host: "login.microsoftonline.com", port: 443 }],
      },
    });
  });

  it("restores the Teams-owned Outlook login binding when Teams is re-enabled", () => {
    const merged = mergeReplacementPolicyAccess(
      `version: 1
network_policies:
  outlook_graph:
    endpoints:
      - host: login.microsoftonline.com
        port: 443
`,
      "version: 1\nnetwork_policies: {}\n",
      ["teams"],
      [],
      [
        `version: 1
network_policies:
  teams:
    endpoints:
      - host: login.microsoftonline.com
        port: 443
        credential_binding: {provider: alpha-teams-bridge}
`,
      ],
      "alpha",
    );

    expect(YAML.parse(merged.source).network_policies).toEqual({
      outlook_graph: {
        endpoints: [
          {
            host: "login.microsoftonline.com",
            port: 443,
            credential_binding: { provider: "alpha-teams-bridge" },
          },
        ],
      },
      teams: {
        endpoints: [
          {
            host: "login.microsoftonline.com",
            port: 443,
            credential_binding: { provider: "alpha-teams-bridge" },
          },
        ],
      },
    });
  });

  it.each(["openclaw", "hermes"] as const)(
    "preserves the complete %s messaging policy lifecycle across rebuilds",
    (agent) => {
      const channels = [
        "telegram",
        "discord",
        "wechat",
        "slack",
        "whatsapp",
        "teams",
        "googlechat",
      ];
      const removedChannels = ["wechat", "teams", "googlechat"];
      const remainingChannels = ["telegram", "discord", "slack", "whatsapp"];
      const sandboxName = `lifecycle-${agent}`;
      const baseSource = fs.readFileSync(
        path.join(process.cwd(), "agents", agent, "policy-permissive.yaml"),
        "utf8",
      );
      const keysByChannel = getMessagingPolicyKeysByChannel({ agent });
      const keysFor = (selected: string[]) =>
        selected.flatMap((channel) => [...(keysByChannel[channel] ?? [])]);
      const compose = (selected: string[]) =>
        policies.mergePresetNamesIntoPolicy(
          baseSource,
          allMessagingChannelPolicyPresets(selected),
          { agent, sandboxName, credentialBoundMessagingChannels: selected },
        ).policy;

      const activeDocument = YAML.parse(compose(channels));
      activeDocument.network_policies.github.endpoints[0].host = "host-maintained.example.com";
      const activeSource = YAML.stringify(activeDocument);
      expect(getCredentialBindingProviders(activeSource)).toContain(
        `${sandboxName}-teams-bridge`,
      );

      const stopped = mergeReplacementPolicyAccess(
        activeSource,
        baseSource,
        [],
        keysFor(channels),
        [],
        sandboxName,
      ).source;
      expect(getCredentialBindingProviders(stopped)).toEqual([]);

      const reenabled = mergeReplacementPolicyAccess(
        stopped,
        compose(channels),
        keysFor(channels),
        [],
        [],
        sandboxName,
      ).source;
      expect(getCredentialBindingProviders(reenabled)).toContain(
        `${sandboxName}-teams-bridge`,
      );

      const selectedRemoved = mergeReplacementPolicyAccess(
        reenabled,
        compose(remainingChannels),
        keysFor(remainingChannels),
        keysFor(removedChannels),
        [],
        sandboxName,
      ).source;
      expect(getCredentialBindingProviders(selectedRemoved)).not.toContain(
        `${sandboxName}-teams-bridge`,
      );

      expect(YAML.parse(stopped).network_policies.github.endpoints[0].host).toBe(
        "host-maintained.example.com",
      );
      expect(YAML.parse(reenabled).network_policies.github.endpoints[0].host).toBe(
        "host-maintained.example.com",
      );
      expect(YAML.parse(selectedRemoved).network_policies.github.endpoints[0].host).toBe(
        "host-maintained.example.com",
      );
      const finalPolicies = YAML.parse(selectedRemoved).network_policies;
      expect(Object.keys(finalPolicies)).not.toEqual(
        expect.arrayContaining(keysFor(removedChannels)),
      );
      expect(Object.keys(finalPolicies)).toEqual(expect.arrayContaining(keysFor(remainingChannels)));
    },
  );
});

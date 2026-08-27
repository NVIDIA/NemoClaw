// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";

import { SHIPPED_MANAGED_IMAGE_AGENTS } from "./managed-image/contract";
import {
  MANAGED_STARTUP_COMPLETION_FILE,
  MANAGED_STARTUP_MERGED_CA_FILE,
  MANAGED_STARTUP_RUNTIME_ENV_FILE,
} from "./managed-startup/image-runtime";
import {
  MANAGED_STARTUP_SHARED_COMMIT_RECEIPT_DIRECTORY,
  MANAGED_STARTUP_SHARED_ROLLBACK_RECEIPT_DIRECTORY,
  MANAGED_STARTUP_SHARED_TRANSACTION_DIRECTORY,
} from "./managed-startup/shared-state-transaction";
import { prepareInitialSandboxCreatePolicy } from "./initial-policy";

type PolicyRule = {
  allow?: {
    method?: string;
    path?: string;
  };
};

type PolicyEndpoint = {
  host?: string;
  port?: number;
  path?: string;
  access?: string;
  protocol?: string;
  enforcement?: string;
  tls?: string;
  allowed_ips?: string[];
  request_body_credential_rewrite?: boolean;
  credential_binding?: { provider?: string };
  rules?: PolicyRule[];
};

type PolicyEntry = {
  binaries?: Array<{ path?: string }>;
  endpoints?: PolicyEndpoint[];
};

type PolicyDocument = {
  filesystem_policy?: { read_only?: string[]; read_write?: string[] };
  network_policies?: Record<string, PolicyEntry>;
};

const cleanupFns: Array<() => boolean | undefined> = [];

afterEach(() => {
  for (const cleanup of cleanupFns.splice(0)) {
    cleanup();
  }
});

function repoPath(...segments: string[]): string {
  return path.join(import.meta.dirname, "..", "..", "..", ...segments);
}

function normalizeFilesystemPolicyPath(policyPath: string): string {
  return path.posix.normalize(policyPath).replace(/\/+$/, "") || "/";
}

function filesystemPolicyAncestors(policyPath: string): string[] {
  const segments = normalizeFilesystemPolicyPath(policyPath).split("/").filter(Boolean);
  return [
    "/",
    ...segments.slice(0, -1).map((_, index) => `/${segments.slice(0, index + 1).join("/")}`),
  ];
}

function readPreparedPolicy(prepared: {
  policyPath: string;
  cleanup?: () => boolean;
}): PolicyDocument {
  cleanupFns.push(() => prepared.cleanup?.());
  return YAML.parse(fs.readFileSync(prepared.policyPath, "utf-8")) as PolicyDocument;
}

describe("initial sandbox policy real preset merge", () => {
  const managedImagePolicyPathsByAgent = {
    openclaw: [
      ["nemoclaw-blueprint", "policies", "openclaw-sandbox.yaml"],
      ["nemoclaw-blueprint", "policies", "openclaw-sandbox-permissive.yaml"],
      ["agents", "openclaw", "policy-permissive.yaml"],
    ],
    hermes: [
      ["agents", "hermes", "policy-additions.yaml"],
      ["agents", "hermes", "policy-permissive.yaml"],
    ],
    "langchain-deepagents-code": [["agents", "langchain-deepagents-code", "policy-additions.yaml"]],
  } as const satisfies Record<
    (typeof SHIPPED_MANAGED_IMAGE_AGENTS)[number],
    readonly (readonly string[])[]
  >;

  const managedImagePolicyCases = SHIPPED_MANAGED_IMAGE_AGENTS.flatMap((agent) =>
    managedImagePolicyPathsByAgent[agent].map((policyPath) => ({ path: policyPath, agent })),
  );
  const shippingPolicyCases = managedImagePolicyCases.filter(
    ({ agent }) => agent !== "langchain-deepagents-code",
  );
  const managedStartupReadOnlyPaths = [
    { path: MANAGED_STARTUP_MERGED_CA_FILE, issue: "#9360", purpose: "CA bundle" },
    {
      path: MANAGED_STARTUP_RUNTIME_ENV_FILE,
      issue: "#9357",
      purpose: "runtime environment",
    },
  ] as const;
  const protectedManagedStartupPaths = [
    MANAGED_STARTUP_COMPLETION_FILE,
    "/run/nemoclaw/openclaw-config-guard",
    MANAGED_STARTUP_SHARED_ROLLBACK_RECEIPT_DIRECTORY,
    MANAGED_STARTUP_SHARED_TRANSACTION_DIRECTORY,
    MANAGED_STARTUP_SHARED_COMMIT_RECEIPT_DIRECTORY,
  ] as const;
  const hermesRuntimeStateMutationControl = {
    receipts: "/var/lib/nemoclaw/runtime-state-mutation",
    startupHandoff: "/run/nemoclaw/runtime-state-mutation-startup",
  } as const;

  it("covers the complete shipped managed startup trust policy matrix", () => {
    const policyIdentities = managedImagePolicyCases.map(
      ({ path: policyPath, agent }) => `${agent}:${policyPath.join("/")}`,
    );

    expect(Object.keys(managedImagePolicyPathsByAgent)).toEqual([...SHIPPED_MANAGED_IMAGE_AGENTS]);
    expect(policyIdentities).toHaveLength(6);
    expect(new Set(policyIdentities).size).toBe(policyIdentities.length);
    expect(managedStartupReadOnlyPaths.map(({ path: trustedPath }) => trustedPath)).toEqual([
      MANAGED_STARTUP_MERGED_CA_FILE,
      MANAGED_STARTUP_RUNTIME_ENV_FILE,
    ]);
  });

  it.each(
    managedImagePolicyCases.flatMap((policyCase) =>
      managedStartupReadOnlyPaths.map((trustedPath) => ({ policyCase, trustedPath })),
    ),
  )(
    "grants $policyCase.agent policy $policyCase.path exact read-only access to the managed startup $trustedPath.purpose ($trustedPath.issue)",
    ({ policyCase, trustedPath }) => {
      const prepared = prepareInitialSandboxCreatePolicy(repoPath(...policyCase.path), [], {
        agentName: policyCase.agent,
      });
      const policy = readPreparedPolicy(prepared);
      const readOnly = policy.filesystem_policy?.read_only ?? [];
      const readWrite = policy.filesystem_policy?.read_write ?? [];
      const normalizedReadOnly = readOnly.map(normalizeFilesystemPolicyPath);
      const normalizedReadWrite = readWrite.map(normalizeFilesystemPolicyPath);
      const trustedPathAncestors = filesystemPolicyAncestors(trustedPath.path);

      expect(readOnly, policyCase.path.join("/")).toContain(trustedPath.path);
      expect(normalizedReadWrite, policyCase.path.join("/")).not.toContain(trustedPath.path);
      expect(
        normalizedReadOnly.filter((candidate) => trustedPathAncestors.includes(candidate)),
        policyCase.path.join("/"),
      ).toEqual([]);
      expect(
        normalizedReadWrite.filter((candidate) => trustedPathAncestors.includes(candidate)),
        policyCase.path.join("/"),
      ).toEqual([]);
    },
  );

  it.each([
    ["agents/hermes/policy-additions.yaml", "restricted"],
    ["agents/hermes/policy-permissive.yaml", "permissive"],
  ])("grants the exact Hermes state-mutation control channels in the %s policy", (policyPath) => {
    const effective = readPreparedPolicy(
      prepareInitialSandboxCreatePolicy(repoPath(...policyPath.split("/")), [], {
        agentName: "hermes",
      }),
    );
    const readOnly = effective.filesystem_policy?.read_only ?? [];
    const readWrite = effective.filesystem_policy?.read_write ?? [];

    expect(readOnly).toContain(hermesRuntimeStateMutationControl.receipts);
    expect(readWrite).not.toContain(hermesRuntimeStateMutationControl.receipts);
    expect(readWrite).toContain(hermesRuntimeStateMutationControl.startupHandoff);
    expect(readOnly).not.toContain(hermesRuntimeStateMutationControl.startupHandoff);
    expect([...readOnly, ...readWrite]).not.toContain("/var/lib/nemoclaw");
    expect([...readOnly, ...readWrite]).not.toContain("/run/nemoclaw");
  });

  it.each(
    managedImagePolicyCases.flatMap((policyCase) =>
      protectedManagedStartupPaths.map((protectedPath) => ({ policyCase, protectedPath })),
    ),
  )(
    "keeps $protectedPath inaccessible in $policyCase.agent policy $policyCase.path (#9357)",
    ({ policyCase, protectedPath }) => {
      const prepared = prepareInitialSandboxCreatePolicy(repoPath(...policyCase.path), [], {
        agentName: policyCase.agent,
      });
      const policy = readPreparedPolicy(prepared);
      const grantedPaths = [
        ...(policy.filesystem_policy?.read_only ?? []),
        ...(policy.filesystem_policy?.read_write ?? []),
      ].map(normalizeFilesystemPolicyPath);
      const exposingGrants = new Set([
        ...filesystemPolicyAncestors(protectedPath),
        normalizeFilesystemPolicyPath(protectedPath),
      ]);

      expect(
        grantedPaths.filter((candidate) => exposingGrants.has(candidate)),
        `${policyCase.path.join("/")} exposes ${protectedPath}`,
      ).toEqual([]);
    },
  );

  it.each([
    {
      path: ["nemoclaw-blueprint", "policies", "openclaw-sandbox.yaml"],
      agent: "openclaw",
    },
    { path: ["agents", "hermes", "policy-additions.yaml"], agent: "hermes" },
    {
      path: ["agents", "langchain-deepagents-code", "policy-additions.yaml"],
      agent: "langchain-deepagents-code",
    },
    { path: ["agents", "nemocua", "policy-additions.yaml"], agent: "nemocua" },
  ])(
    "keeps $agent on the provider-neutral inference.local route without host-native inference egress",
    ({ path: policyPath, agent }) => {
      const effective = readPreparedPolicy(
        prepareInitialSandboxCreatePolicy(repoPath(...policyPath), [], { agentName: agent }),
      );
      const endpoints = Object.values(effective.network_policies ?? {}).flatMap(
        (policy) => policy.endpoints ?? [],
      );

      expect(endpoints).toContainEqual(
        expect.objectContaining({ host: "inference.local", port: 443 }),
      );
      expect(
        endpoints.filter(
          (endpoint) =>
            endpoint.host === "host.openshell.internal" &&
            [8000, 8001, 8081, 11434, 11435].includes(endpoint.port ?? 0),
        ),
      ).toEqual([]);
    },
  );

  it("limits NemoCUA managed inference to the prepared image clients (#9649)", () => {
    const effective = readPreparedPolicy(
      prepareInitialSandboxCreatePolicy(
        repoPath("agents", "nemocua", "policy-additions.yaml"),
        [],
        { agentName: "nemocua" },
      ),
    );

    const managedInference = effective.network_policies?.managed_inference;

    expect(effective.filesystem_policy?.read_only).toContain(MANAGED_STARTUP_MERGED_CA_FILE);
    expect(managedInference).toEqual({
      name: "managed_inference",
      endpoints: [
        {
          host: "inference.local",
          port: 443,
          protocol: "rest",
          enforcement: "enforce",
          rules: [
            { allow: { method: "POST", path: "/v1/chat/completions" } },
            { allow: { method: "POST", path: "/v1/responses" } },
            { allow: { method: "GET", path: "/v1/models" } },
            { allow: { method: "GET", path: "/v1/models/**" } },
          ],
        },
      ],
      binaries: [
        { path: "/usr/bin/python3" },
        { path: "/usr/local/bin/python3" },
        { path: "/usr/bin/curl" },
      ],
    });
    expect(managedInference?.endpoints?.[0]).not.toHaveProperty("access");
  });

  it("uses Hermes channel YAML when the Hermes base policy path implies the agent", () => {
    const prepared = prepareInitialSandboxCreatePolicy(
      repoPath("agents", "hermes", "policy-additions.yaml"),
      ["discord", "slack"],
      { sandboxName: "hermes-channel" },
    );
    const policy = readPreparedPolicy(prepared);

    expect(prepared.appliedPresets).toEqual(["discord", "slack"]);

    const slackBinaries =
      policy.network_policies?.slack?.binaries?.map((binary) => binary.path) ?? [];
    expect(slackBinaries).toEqual([
      "/usr/local/bin/hermes",
      "/usr/bin/python3*",
      "/opt/hermes/.venv/bin/python",
    ]);

    const discordBinaries =
      policy.network_policies?.discord?.binaries?.map((binary) => binary.path) ?? [];
    expect(discordBinaries).toContain("/usr/bin/python3*");
    expect(discordBinaries).toContain("/opt/hermes/.venv/bin/python");
    expect(discordBinaries).not.toContain("/usr/bin/node");

    const boundProviders =
      policy.network_policies?.discord?.endpoints
        ?.map((endpoint) => endpoint.credential_binding?.provider)
        .filter(Boolean) ?? [];
    expect(boundProviders).toEqual([
      "hermes-channel-discord-bridge",
      "hermes-channel-discord-bridge",
      "hermes-channel-discord-bridge",
    ]);

    const discordRules =
      policy.network_policies?.discord?.endpoints
        ?.find((endpoint) => endpoint.host === "discord.com")
        ?.rules?.map((rule) => rule.allow) ?? [];
    expect(discordRules).not.toContainEqual({ method: "PUT", path: "/**" });
    expect(discordRules).not.toContainEqual({ method: "PATCH", path: "/**" });
  });

  it("lets the OpenClaw Discord bot manage its own application commands (#7298)", () => {
    const prepared = prepareInitialSandboxCreatePolicy(
      repoPath("nemoclaw-blueprint", "policies", "openclaw-sandbox.yaml"),
      [],
      // A sandbox name is required now that the OpenClaw Discord preset binds
      // its credential: {sandboxName}-discord-bridge cannot be materialized
      // without one. Onboard and snapshot restore both supply it.
      {
        agentName: "openclaw",
        additionalPresets: ["discord"],
        sandboxName: "openclaw-discord",
      },
    );
    const policy = readPreparedPolicy(prepared);

    const discordRules =
      policy.network_policies?.discord?.endpoints
        ?.find((endpoint) => endpoint.host === "discord.com")
        ?.rules?.map((rule) => rule.allow) ?? [];
    expect(discordRules).toContainEqual({
      method: "DELETE",
      path: "/api/v*/applications/*/commands/*",
    });
    expect(discordRules).toContainEqual({
      method: "DELETE",
      path: "/api/v*/channels/*/messages/*",
    });
    expect(discordRules).not.toContainEqual({
      method: "DELETE",
      path: "/**",
    });
    expect(discordRules).not.toContainEqual({
      method: "DELETE",
      path: "/api/v*/guilds/*",
    });
    const credentialEndpoints = (policy.network_policies?.discord?.endpoints ?? []).filter(
      (endpoint) =>
        endpoint.host === "discord.com" ||
        endpoint.host === "gateway.discord.gg" ||
        endpoint.host === "*.discord.gg",
    );
    expect(credentialEndpoints).toHaveLength(3);
    expect(credentialEndpoints.map((endpoint) => endpoint.credential_binding?.provider)).toEqual([
      "openclaw-discord-discord-bridge",
      "openclaw-discord-discord-bridge",
      "openclaw-discord-discord-bridge",
    ]);
  });

  it.each(shippingPolicyCases)(
    "prepares $agent policy $path with writable PTY devices but not their symlink",
    (policyCase) => {
      const prepared = prepareInitialSandboxCreatePolicy(repoPath(...policyCase.path), [], {
        agentName: policyCase.agent,
      });
      const policy = readPreparedPolicy(prepared);
      const readWrite = policy.filesystem_policy?.read_write ?? [];

      expect(readWrite, policyCase.path.join("/")).toContain("/dev/pts");
      expect(readWrite, policyCase.path.join("/")).not.toContain("/dev/ptmx");
    },
  );

  it.each(
    managedImagePolicyCases.flatMap((policyCase) =>
      ["/", "/var", "/var/lib", "/var/lib/dpkg"].map((writableAncestor) => ({
        policyCase,
        writableAncestor,
      })),
    ),
  )(
    "grants $policyCase.agent policy $policyCase.path read-only package access without writable $writableAncestor (#8467)",
    ({ policyCase, writableAncestor }) => {
      const prepared = prepareInitialSandboxCreatePolicy(repoPath(...policyCase.path), [], {
        agentName: policyCase.agent,
      });
      const policy = readPreparedPolicy(prepared);
      const readOnly = policy.filesystem_policy?.read_only ?? [];
      const readWrite = policy.filesystem_policy?.read_write ?? [];

      expect(readOnly, policyCase.path.join("/")).toContain("/var/lib/dpkg");
      expect(readWrite, policyCase.path.join("/")).not.toContain(writableAncestor);
    },
  );

  it.each([
    "nemoclaw-blueprint/policies/openclaw-sandbox-permissive.yaml",
    "agents/openclaw/policy-permissive.yaml",
  ])("preserves baseline writable paths in effective OpenClaw permissive policy %s", (policy) => {
    const baseline = readPreparedPolicy(
      prepareInitialSandboxCreatePolicy(
        repoPath("nemoclaw-blueprint", "policies", "openclaw-sandbox.yaml"),
        [],
        { agentName: "openclaw" },
      ),
    );
    const baselineReadWrite = baseline.filesystem_policy?.read_write ?? [];
    expect(baselineReadWrite).toContain("/home/linuxbrew");

    const policyPath = repoPath(...policy.split("/"));
    const effective = readPreparedPolicy(
      prepareInitialSandboxCreatePolicy(policyPath, [], { agentName: "openclaw" }),
    );
    expect(effective.filesystem_policy?.read_write, policyPath).toEqual(
      expect.arrayContaining(baselineReadWrite),
    );
  });

  it.each(
    [
      {
        path: repoPath("nemoclaw-blueprint", "policies", "openclaw-sandbox-permissive.yaml"),
        agent: "openclaw",
      },
      { path: repoPath("agents", "hermes", "policy-permissive.yaml"), agent: "hermes" },
    ].flatMap((policyCase) =>
      ["slack.com", "api.slack.com", "hooks.slack.com"].map((host) => ({ policyCase, host })),
    ),
  )("keeps Slack credential rewrite for $policyCase.agent on $host", ({ policyCase, host }) => {
    const effective = readPreparedPolicy(
      prepareInitialSandboxCreatePolicy(policyCase.path, ["slack"], {
        agentName: policyCase.agent,
      }),
    );
    const slackEndpoints = effective.network_policies?.slack?.endpoints ?? [];
    const endpoint = slackEndpoints.find((candidate) => candidate.host === host);
    expect(endpoint, `${policyCase.agent}:${host}`).toMatchObject({
      protocol: "rest",
      request_body_credential_rewrite: true,
    });
  });

  it("materializes Hermes Discord credential bindings from the target sandbox name", () => {
    const sandboxName = "hermes-discord-e2e";
    const effective = readPreparedPolicy(
      prepareInitialSandboxCreatePolicy(
        repoPath("agents", "hermes", "policy-additions.yaml"),
        ["discord"],
        { agentName: "hermes", sandboxName },
      ),
    );
    const endpoints = effective.network_policies?.discord?.endpoints ?? [];
    const credentialEndpoints = endpoints.filter((endpoint) =>
      ["discord.com", "gateway.discord.gg", "*.discord.gg"].includes(endpoint.host ?? ""),
    );

    expect(credentialEndpoints.map((endpoint) => endpoint.host).sort()).toEqual([
      "*.discord.gg",
      "discord.com",
      "gateway.discord.gg",
    ]);
    expect(credentialEndpoints.map((endpoint) => endpoint.credential_binding?.provider)).toEqual([
      `${sandboxName}-discord-bridge`,
      `${sandboxName}-discord-bridge`,
      `${sandboxName}-discord-bridge`,
    ]);
    expect(JSON.stringify(effective)).not.toContain("{sandboxName}");
  });

  it("uses a more specific route for the Hermes Slack app credential binding (#10155)", () => {
    const sandboxName = "hermes-slack-e2e";
    const effective = readPreparedPolicy(
      prepareInitialSandboxCreatePolicy(
        repoPath("agents", "hermes", "policy-additions.yaml"),
        ["slack"],
        { agentName: "hermes", sandboxName },
      ),
    );
    const endpoints = effective.network_policies?.slack?.endpoints ?? [];
    const slackCom = endpoints.filter((endpoint) => endpoint.host === "slack.com");
    const websocketEndpoints = endpoints.filter((endpoint) =>
      ["wss-primary.slack.com", "wss-backup.slack.com"].includes(endpoint.host ?? ""),
    );

    expect(slackCom).toHaveLength(2);
    expect(
      slackCom.map((endpoint) => ({
        path: endpoint.path,
        provider: endpoint.credential_binding?.provider,
      })),
    ).toEqual([
      { path: "/api/apps.connections.open", provider: `${sandboxName}-slack-app` },
      { path: undefined, provider: `${sandboxName}-slack-bridge` },
    ]);
    expect(websocketEndpoints.map((endpoint) => endpoint.credential_binding?.provider)).toEqual([
      `${sandboxName}-slack-app`,
      `${sandboxName}-slack-app`,
    ]);
    expect(
      endpoints
        .filter((endpoint) => ["api.slack.com", "hooks.slack.com"].includes(endpoint.host ?? ""))
        .map((endpoint) => endpoint.credential_binding?.provider),
    ).toEqual([`${sandboxName}-slack-bridge`, `${sandboxName}-slack-bridge`]);
    expect(JSON.stringify(effective)).not.toContain("{sandboxName}");
  });

  it.each([
    ["missing", undefined],
    ["unsafe", "bad:provider"],
  ])(
    "rejects a Hermes Discord create policy with a %s target sandbox name",
    (_case, sandboxName) => {
      expect(() =>
        prepareInitialSandboxCreatePolicy(
          repoPath("agents", "hermes", "policy-additions.yaml"),
          ["discord"],
          { agentName: "hermes", sandboxName },
        ),
      ).toThrow("a valid sandbox name is required to materialize credential bindings");
    },
  );

  it.each(shippingPolicyCases.slice(0, 3).concat(shippingPolicyCases.slice(4)))(
    "keeps optional Claude hosts out of $agent create policy $path",
    (policyCase) => {
      const claudeHosts = new Set(["api.anthropic.com", "statsig.anthropic.com", "sentry.io"]);
      const effective = readPreparedPolicy(
        prepareInitialSandboxCreatePolicy(repoPath(...policyCase.path), [], {
          agentName: policyCase.agent,
        }),
      );
      const hosts = Object.values(effective.network_policies ?? {}).flatMap((policy) =>
        (policy.endpoints ?? [])
          .map((endpoint) => endpoint.host)
          .filter((host): host is string => typeof host === "string"),
      );
      expect(
        hosts.filter((host) => claudeHosts.has(host)),
        policyCase.path.join("/"),
      ).toEqual([]);
    },
  );

  it.each(["files.pythonhosted.org", "pypi.org"])(
    "prepares Hermes package access for %s with read-only runtime and verification identities",
    (host) => {
      const effective = readPreparedPolicy(
        prepareInitialSandboxCreatePolicy(
          repoPath("agents", "hermes", "policy-additions.yaml"),
          [],
          {
            agentName: "hermes",
          },
        ),
      );
      const pypi = effective.network_policies?.pypi;
      const binaryPaths = pypi?.binaries?.map((binary) => binary.path) ?? [];

      expect(binaryPaths).toEqual(
        expect.arrayContaining([
          "/usr/bin/curl",
          "/usr/local/bin/curl",
          "/usr/local/bin/pip3",
          "/usr/bin/python3*",
          "/opt/hermes/.venv/bin/python",
        ]),
      );
      expect((pypi?.endpoints ?? []).map((endpoint) => endpoint.host).sort()).toEqual([
        "files.pythonhosted.org",
        "pypi.org",
      ]);
      const endpoint = pypi?.endpoints?.find((candidate) => candidate.host === host);
      expect(endpoint).toMatchObject({ protocol: "rest" });
      expect((endpoint?.rules ?? []).map((rule) => rule.allow?.method)).toEqual(["GET"]);
    },
  );

  it("adds backend-neutral trace egress only to the requested DCode create policy", () => {
    const prepared = prepareInitialSandboxCreatePolicy(
      repoPath("agents", "langchain-deepagents-code", "policy-additions.yaml"),
      [],
      {
        agentName: "langchain-deepagents-code",
        policyTier: "balanced",
        additionalPresets: ["observability-otlp-local"],
      },
    );
    const effective = readPreparedPolicy(prepared);

    expect(prepared.appliedPresets).toContain("observability-otlp-local");
    expect(effective.network_policies?.["observability-otlp-local"]).toBeDefined();
  });

  it.each([
    {
      label: "restricted OpenClaw policy",
      path: ["nemoclaw-blueprint", "policies", "openclaw-sandbox.yaml"],
      agent: "openclaw",
    },
    {
      label: "permissive OpenClaw blueprint policy",
      path: ["nemoclaw-blueprint", "policies", "openclaw-sandbox-permissive.yaml"],
      agent: "openclaw",
    },
    {
      label: "permissive OpenClaw agent policy",
      path: ["agents", "openclaw", "policy-permissive.yaml"],
      agent: "openclaw",
    },
    {
      label: "Hermes policy additions",
      path: ["agents", "hermes", "policy-additions.yaml"],
      agent: "hermes",
    },
    {
      label: "permissive Hermes policy",
      path: ["agents", "hermes", "policy-permissive.yaml"],
      agent: "hermes",
    },
  ] as const)(
    "keeps shipping policy methods explicit and avoids deprecated REST TLS mode for $label",
    (policyCase) => {
      const effective = readPreparedPolicy(
        prepareInitialSandboxCreatePolicy(repoPath(...policyCase.path), [], {
          agentName: policyCase.agent,
        }),
      );
      for (const [policyName, policy] of Object.entries(effective.network_policies ?? {})) {
        const endpoints = policy.endpoints ?? [];
        for (const endpoint of endpoints) {
          expect(
            (endpoint.rules ?? []).map((rule) => rule.allow?.method),
            `${policyCase.path.join("/")}:${policyName}:${endpoint.host}`,
          ).not.toContain("*");
        }
        for (const endpoint of endpoints.filter(({ protocol }) => protocol === "rest")) {
          expect(endpoint.tls).not.toBe("terminate");
        }
      }
    },
  );

  it("keeps the Restricted OpenClaw npm baseline inspected and GET-only (#8497)", () => {
    const baselinePath = repoPath("nemoclaw-blueprint", "policies", "openclaw-sandbox.yaml");
    const reviewed = YAML.parse(fs.readFileSync(baselinePath, "utf-8")) as PolicyDocument;
    const effective = readPreparedPolicy(
      prepareInitialSandboxCreatePolicy(baselinePath, [], {
        agentName: "openclaw",
        policyTier: "restricted",
      }),
    );

    expect(effective.network_policies?.npm_registry).toEqual(
      reviewed.network_policies?.npm_registry,
    );
    const endpoint = effective.network_policies?.npm_registry?.endpoints?.[0];
    expect(endpoint).toMatchObject({ protocol: "rest", enforcement: "enforce" });
    expect(endpoint).not.toHaveProperty("access");
    expect(endpoint?.rules?.map((rule) => rule.allow)).toEqual([{ method: "GET", path: "/**" }]);
  });

  it("composes default OpenClaw package and pricing routes without v0.0.99 ambiguity (#8497)", () => {
    const effective = readPreparedPolicy(
      prepareInitialSandboxCreatePolicy(
        repoPath("nemoclaw-blueprint", "policies", "openclaw-sandbox.yaml"),
        [],
        {
          agentName: "openclaw",
          policyTier: "balanced",
          additionalPresets: ["npm", "brew", "openclaw-pricing"],
        },
      ),
    );
    const endpoint = (policyName: string, host: string): PolicyEndpoint => {
      const match = effective.network_policies?.[policyName]?.endpoints?.find(
        (candidate) => candidate.host === host,
      );
      expect(match, `${policyName}:${host}`).toBeDefined();
      return match ?? {};
    };
    const connectionMetadata = (candidate: PolicyEndpoint) => ({
      tls: candidate.tls ?? "auto",
      allowedIps: [...(candidate.allowed_ips ?? [])].sort(),
    });
    const requestMetadata = (candidate: PolicyEndpoint) => ({
      protocol: candidate.protocol ?? "",
      enforcement: candidate.enforcement ?? "audit",
    });

    const baselineNpm = endpoint("npm_registry", "registry.npmjs.org");
    const presetNpm = endpoint("npm_yarn", "registry.npmjs.org");
    expect(connectionMetadata(baselineNpm)).toEqual(connectionMetadata(presetNpm));
    expect(requestMetadata(baselineNpm)).toEqual(requestMetadata(presetNpm));
    expect(baselineNpm).toMatchObject({ access: "full", tls: "skip" });
    expect(baselineNpm).not.toHaveProperty("protocol");
    expect(baselineNpm).not.toHaveProperty("rules");
    expect(effective.network_policies?.npm_registry?.binaries).toEqual([
      { path: "/usr/local/bin/openclaw" },
    ]);

    const brewRaw = endpoint("brew", "raw.githubusercontent.com");
    const pricingRaw = endpoint("openclaw-pricing", "raw.githubusercontent.com");
    expect(connectionMetadata(brewRaw)).toEqual(connectionMetadata(pricingRaw));
    expect(brewRaw).not.toHaveProperty("protocol");
    expect(pricingRaw).toMatchObject({ protocol: "rest", enforcement: "enforce" });
    expect(effective.network_policies?.brew?.binaries).not.toEqual(
      expect.arrayContaining([{ path: "/usr/local/bin/node" }, { path: "/usr/bin/node" }]),
    );
  });
});

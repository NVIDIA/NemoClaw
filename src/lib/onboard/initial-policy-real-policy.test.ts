// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";

import { prepareInitialSandboxCreatePolicy } from "./initial-policy";

type PolicyRule = {
  allow?: {
    method?: string;
    path?: string;
  };
};

type PolicyEndpoint = {
  host?: string;
  protocol?: string;
  tls?: string;
  request_body_credential_rewrite?: boolean;
  rules?: PolicyRule[];
};

type PolicyEntry = {
  binaries?: Array<{ path?: string }>;
  endpoints?: PolicyEndpoint[];
};

type PolicyDocument = {
  filesystem_policy?: { read_write?: string[] };
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

function readPreparedPolicy(prepared: {
  policyPath: string;
  cleanup?: () => boolean;
}): PolicyDocument {
  cleanupFns.push(() => prepared.cleanup?.());
  return YAML.parse(fs.readFileSync(prepared.policyPath, "utf-8")) as PolicyDocument;
}

describe("initial sandbox policy real preset merge", () => {
  it("uses Hermes channel YAML when the Hermes base policy path implies the agent", () => {
    const prepared = prepareInitialSandboxCreatePolicy(
      repoPath("agents", "hermes", "policy-additions.yaml"),
      ["discord", "slack"],
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

    const discordRules =
      policy.network_policies?.discord?.endpoints
        ?.find((endpoint) => endpoint.host === "discord.com")
        ?.rules?.map((rule) => rule.allow) ?? [];
    expect(discordRules).not.toContainEqual({ method: "PUT", path: "/**" });
    expect(discordRules).not.toContainEqual({ method: "PATCH", path: "/**" });
  });

  it("prepares every shipping sandbox policy with writable PTY devices but not their symlink", () => {
    const policyCases = [
      { path: ["nemoclaw-blueprint", "policies", "openclaw-sandbox.yaml"], agent: "openclaw" },
      {
        path: ["nemoclaw-blueprint", "policies", "openclaw-sandbox-permissive.yaml"],
        agent: "openclaw",
      },
      { path: ["agents", "openclaw", "policy-permissive.yaml"], agent: "openclaw" },
      { path: ["agents", "hermes", "policy-additions.yaml"], agent: "hermes" },
      { path: ["agents", "hermes", "policy-permissive.yaml"], agent: "hermes" },
    ];

    for (const policyCase of policyCases) {
      const prepared = prepareInitialSandboxCreatePolicy(repoPath(...policyCase.path), [], {
        agentName: policyCase.agent,
      });
      const policy = readPreparedPolicy(prepared);
      const readWrite = policy.filesystem_policy?.read_write ?? [];

      expect(readWrite, policyCase.path.join("/")).toContain("/dev/pts");
      expect(readWrite, policyCase.path.join("/")).not.toContain("/dev/ptmx");
    }
  });

  it("preserves baseline writable paths in effective OpenClaw permissive create policies", () => {
    const baseline = readPreparedPolicy(
      prepareInitialSandboxCreatePolicy(
        repoPath("nemoclaw-blueprint", "policies", "openclaw-sandbox.yaml"),
        [],
        { agentName: "openclaw" },
      ),
    );
    const baselineReadWrite = baseline.filesystem_policy?.read_write ?? [];
    expect(baselineReadWrite).toContain("/home/linuxbrew");

    for (const policyPath of [
      repoPath("nemoclaw-blueprint", "policies", "openclaw-sandbox-permissive.yaml"),
      repoPath("agents", "openclaw", "policy-permissive.yaml"),
    ]) {
      const effective = readPreparedPolicy(
        prepareInitialSandboxCreatePolicy(policyPath, [], { agentName: "openclaw" }),
      );
      expect(effective.filesystem_policy?.read_write, policyPath).toEqual(
        expect.arrayContaining(baselineReadWrite),
      );
    }
  });

  it("keeps Slack request-body credential rewrite in permissive create policies", () => {
    const policyCases = [
      {
        path: repoPath("nemoclaw-blueprint", "policies", "openclaw-sandbox-permissive.yaml"),
        agent: "openclaw",
      },
      { path: repoPath("agents", "hermes", "policy-permissive.yaml"), agent: "hermes" },
    ];

    for (const policyCase of policyCases) {
      const effective = readPreparedPolicy(
        prepareInitialSandboxCreatePolicy(policyCase.path, ["slack"], {
          agentName: policyCase.agent,
        }),
      );
      const slackEndpoints = effective.network_policies?.slack?.endpoints ?? [];
      for (const host of ["slack.com", "api.slack.com", "hooks.slack.com"]) {
        const endpoint = slackEndpoints.find((candidate) => candidate.host === host);
        expect(endpoint, `${policyCase.agent}:${host}`).toMatchObject({
          protocol: "rest",
          request_body_credential_rewrite: true,
        });
      }
    }
  });

  it("keeps optional Claude hosts out of every default and permissive create policy", () => {
    const claudeHosts = new Set(["api.anthropic.com", "statsig.anthropic.com", "sentry.io"]);
    const policyCases = [
      { path: ["nemoclaw-blueprint", "policies", "openclaw-sandbox.yaml"], agent: "openclaw" },
      {
        path: ["nemoclaw-blueprint", "policies", "openclaw-sandbox-permissive.yaml"],
        agent: "openclaw",
      },
      { path: ["agents", "openclaw", "policy-permissive.yaml"], agent: "openclaw" },
      { path: ["agents", "hermes", "policy-permissive.yaml"], agent: "hermes" },
    ];

    for (const policyCase of policyCases) {
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
    }
  });

  it("prepares Hermes package access with read-only runtime and verification identities", () => {
    const effective = readPreparedPolicy(
      prepareInitialSandboxCreatePolicy(repoPath("agents", "hermes", "policy-additions.yaml"), [], {
        agentName: "hermes",
      }),
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
    for (const endpoint of pypi?.endpoints ?? []) {
      expect(endpoint).toMatchObject({ protocol: "rest" });
      expect((endpoint.rules ?? []).map((rule) => rule.allow?.method)).toEqual(["GET"]);
    }
  });

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

  it("keeps effective shipping policy methods explicit and avoids deprecated REST TLS mode", () => {
    const policyCases = [
      { path: ["nemoclaw-blueprint", "policies", "openclaw-sandbox.yaml"], agent: "openclaw" },
      {
        path: ["nemoclaw-blueprint", "policies", "openclaw-sandbox-permissive.yaml"],
        agent: "openclaw",
      },
      { path: ["agents", "openclaw", "policy-permissive.yaml"], agent: "openclaw" },
      { path: ["agents", "hermes", "policy-additions.yaml"], agent: "hermes" },
      { path: ["agents", "hermes", "policy-permissive.yaml"], agent: "hermes" },
    ];

    for (const policyCase of policyCases) {
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
    }
  });
});

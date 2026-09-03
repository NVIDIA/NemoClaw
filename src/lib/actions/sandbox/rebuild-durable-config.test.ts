// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { ConfigObject } from "../../security/credential-filter";
import { createSession, normalizeSession } from "../../state/onboard-session";
import {
  applyHermesOperatorConfigSnapshot,
  captureHermesOperatorConfigSnapshot,
  captureHermesOperatorConfigSnapshotFromConfig,
  parseHermesOperatorConfigSnapshot,
  resolveRebuildDurableConfig,
  serializeHermesOperatorConfigSnapshot,
  verifyHermesOperatorConfigSnapshot,
} from "./rebuild-durable-config";

describe("resolveRebuildDurableConfig", () => {
  it("keeps the registry tool-disclosure selection authoritative", () => {
    const config = resolveRebuildDurableConfig(
      "alpha",
      { name: "alpha", toolDisclosure: "direct", nemoclawVersion: "0.1.0" },
      createSession({ sandboxName: "alpha", toolDisclosure: "progressive" }),
    );

    expect(config.toolDisclosure).toBe("direct");
    expect(config.toolDisclosureError).toBeNull();
  });

  it("lets an explicit transactional rebuild override the recorded selection", () => {
    const config = resolveRebuildDurableConfig(
      "alpha",
      {
        name: "alpha",
        toolDisclosure: "progressive",
        nemoclawVersion: "0.1.0",
      },
      createSession({ sandboxName: "alpha", toolDisclosure: "progressive" }),
      undefined,
      "direct",
    );

    expect(config.toolDisclosure).toBe("direct");
    expect(config.toolDisclosureError).toBeNull();
  });

  it("recovers tool disclosure from a matching legacy session", () => {
    const config = resolveRebuildDurableConfig(
      "alpha",
      {
        name: "alpha",
        provider: "ollama-local",
        model: "model",
        nemoclawVersion: "0.1.0",
      },
      createSession({
        sandboxName: "alpha",
        provider: "ollama-local",
        model: "model",
        toolDisclosure: "direct",
      }),
    );

    expect(config.toolDisclosure).toBe("direct");
    expect(config.toolDisclosureError).toBeNull();
  });

  it("defaults missing legacy tool-disclosure state to progressive", () => {
    const config = resolveRebuildDurableConfig(
      "alpha",
      { name: "alpha", nemoclawVersion: "0.1.0" },
      null,
    );

    expect(config.toolDisclosure).toBe("progressive");
    expect(config.toolDisclosureError).toBeNull();
  });

  it("fails closed for corrupt durable tool-disclosure state", () => {
    const config = resolveRebuildDurableConfig(
      "alpha",
      {
        name: "alpha",
        toolDisclosure: "everything" as never,
        nemoclawVersion: "0.1.0",
      },
      null,
    );

    expect(config.toolDisclosure).toBe("progressive");
    expect(config.toolDisclosureError).toContain("progressive or direct");
  });

  it("does not let an explicit override mask corrupt durable state", () => {
    const config = resolveRebuildDurableConfig(
      "alpha",
      {
        name: "alpha",
        toolDisclosure: "everything" as never,
        nemoclawVersion: "0.1.0",
      },
      null,
      undefined,
      "direct",
    );

    expect(config.toolDisclosure).toBe("direct");
    expect(config.toolDisclosureError).toContain("progressive or direct");
  });

  it("fails closed for corrupt matching-session state when the registry value is missing", () => {
    const session = normalizeSession({
      version: 1,
      sandboxName: "alpha",
      toolDisclosure: "everything",
    } as never);
    const config = resolveRebuildDurableConfig(
      "alpha",
      { name: "alpha", nemoclawVersion: "0.1.0" },
      session,
    );

    expect(config.toolDisclosureError).toContain("progressive or direct");
  });

  it("uses a matching direct session when a legacy registry stores null", () => {
    const config = resolveRebuildDurableConfig(
      "alpha",
      {
        name: "alpha",
        toolDisclosure: null as never,
        nemoclawVersion: "0.1.0",
      },
      createSession({ sandboxName: "alpha", toolDisclosure: "direct" }),
    );

    expect(config.toolDisclosure).toBe("direct");
    expect(config.toolDisclosureError).toBeNull();
  });

  it("does not mistake a legacy custom policy named brave for web search", () => {
    const config = resolveRebuildDurableConfig(
      "alpha",
      {
        name: "alpha",
        nemoclawVersion: "0.1.0",
      },
      createSession({ sandboxName: "other" }),
    );
    expect(config.webSearchConfig).toBeNull();
  });

  it("keeps an explicit durable web-search disable authoritative", () => {
    const config = resolveRebuildDurableConfig(
      "alpha",
      {
        name: "alpha",
        webSearchEnabled: false,
        fromDockerfile: null,
      },
      createSession({
        sandboxName: "alpha",
        webSearchConfig: { fetchEnabled: true },
      }),
    );
    expect(config.webSearchConfig).toBeNull();
  });

  it("fails closed for an ambiguous legacy image without its matching session", () => {
    const config = resolveRebuildDurableConfig(
      "alpha",
      { name: "alpha", nemoclawVersion: null },
      createSession({ sandboxName: "other" }),
    );
    expect(config.fromDockerfileError).toContain("cannot distinguish");
  });

  it("accepts an ambiguous legacy image only with scoped managed-image confirmation (#6114)", () => {
    const config = resolveRebuildDurableConfig(
      "alpha",
      { name: "alpha", nemoclawVersion: null },
      createSession({ sandboxName: "other" }),
      undefined,
      undefined,
      true,
    );
    expect(config.fromDockerfile).toBeNull();
    expect(config.fromDockerfileError).toBeNull();
  });

  it("rejects matching-session custom-image evidence despite legacy confirmation (#6114)", () => {
    const config = resolveRebuildDurableConfig(
      "alpha",
      {
        name: "alpha",
        provider: "ollama-local",
        model: "model",
        nemoclawVersion: null,
      },
      createSession({
        sandboxName: "alpha",
        provider: "ollama-local",
        model: "model",
        metadata: {
          gatewayName: "nemoclaw",
          fromDockerfile: "/tmp/custom.Dockerfile",
        },
      }),
      undefined,
      undefined,
      true,
    );
    expect(config.fromDockerfileError).toContain("conflicts with a recorded custom --from image");
  });

  it("accepts explicit managed-image provenance for an old agent runtime", () => {
    const config = resolveRebuildDurableConfig(
      "alpha",
      {
        name: "alpha",
        agentVersion: "2026.3.11",
        nemoclawVersion: null,
        fromDockerfile: null,
      },
      createSession({ sandboxName: "other" }),
    );
    expect(config.fromDockerfile).toBeNull();
    expect(config.fromDockerfileError).toBeNull();
  });

  it("does not treat a same-name null image session as proof of a legacy managed image", () => {
    const config = resolveRebuildDurableConfig(
      "alpha",
      {
        name: "alpha",
        provider: "ollama-local",
        model: "model",
        nemoclawVersion: null,
      },
      createSession({
        sandboxName: "alpha",
        provider: "ollama-local",
        model: "model",
      }),
    );
    expect(config.fromDockerfileError).toContain("cannot distinguish");
  });

  it("fails closed for corrupt durable web-search state", () => {
    const config = resolveRebuildDurableConfig(
      "alpha",
      {
        name: "alpha",
        webSearchEnabled: "false" as never,
        fromDockerfile: null,
      },
      null,
    );
    expect(config.webSearchError).toContain("not boolean");
  });

  it("preserves an explicit durable Tavily provider", () => {
    const config = resolveRebuildDurableConfig(
      "alpha",
      {
        name: "alpha",
        webSearchEnabled: true,
        webSearchProvider: "tavily",
        fromDockerfile: null,
      },
      createSession({ sandboxName: "other" }),
    );
    expect(config.webSearchConfig).toEqual({
      fetchEnabled: true,
      provider: "tavily",
    });
    expect(config.webSearchError).toBeNull();
  });

  it("backfills a legacy enabled provider from the matching Tavily session", () => {
    const config = resolveRebuildDurableConfig(
      "alpha",
      {
        name: "alpha",
        provider: "compatible-endpoint",
        model: "model",
        webSearchEnabled: true,
        fromDockerfile: null,
      },
      createSession({
        sandboxName: "alpha",
        provider: "compatible-endpoint",
        model: "model",
        webSearchConfig: { fetchEnabled: true, provider: "tavily" },
      }),
    );
    expect(config.webSearchConfig).toEqual({
      fetchEnabled: true,
      provider: "tavily",
    });
  });

  it("does not infer managed Tavily from the DCode interpreter opt-in preset", () => {
    const config = resolveRebuildDurableConfig(
      "alpha",
      {
        name: "alpha",
        agent: "langchain-deepagents-code",
        nemoclawVersion: "0.1.0",
      },
      createSession({ sandboxName: "other" }),
    );
    expect(config.webSearchConfig).toBeNull();
  });

  it("does not infer managed Tavily from a custom same-name policy", () => {
    const config = resolveRebuildDurableConfig(
      "alpha",
      {
        name: "alpha",
        nemoclawVersion: "0.1.0",
      },
      createSession({ sandboxName: "other", webSearchConfig: null }),
    );
    expect(config.webSearchConfig).toBeNull();
  });

  it("lets an explicit provider resolve stale dual-policy state", () => {
    const config = resolveRebuildDurableConfig(
      "alpha",
      {
        name: "alpha",
        webSearchEnabled: true,
        webSearchProvider: "tavily",
        nemoclawVersion: "0.1.0",
      },
      createSession({ sandboxName: "other", webSearchConfig: null }),
    );
    expect(config.webSearchConfig).toEqual({
      fetchEnabled: true,
      provider: "tavily",
    });
    expect(config.webSearchError).toBeNull();
  });

  it("fails closed for an invalid durable web-search provider", () => {
    const config = resolveRebuildDurableConfig(
      "alpha",
      {
        name: "alpha",
        webSearchEnabled: true,
        webSearchProvider: "other" as never,
        fromDockerfile: null,
      },
      null,
    );
    expect(config.webSearchError).toContain("webSearchProvider");
  });

  it.each([
    ["NOUS_API_KEY", "api_key"],
    ["OPENAI_API_KEY", "oauth"],
  ] as const)("recovers legacy Hermes auth from %s", (credentialEnv, expected) => {
    const config = resolveRebuildDurableConfig(
      "alpha",
      {
        name: "alpha",
        provider: "hermes-provider",
        credentialEnv,
        nemoclawVersion: "0.1.0",
      },
      createSession({ sandboxName: "other" }),
    );
    expect(config.hermesAuthMethod).toBe(expected);
    expect(config.hermesAuthMethodError).toBeNull();
  });

  it("fails closed when legacy Hermes auth has no durable clue", () => {
    const config = resolveRebuildDurableConfig(
      "alpha",
      { name: "alpha", provider: "hermes-provider", nemoclawVersion: "0.1.0" },
      createSession({ sandboxName: "other" }),
    );
    expect(config.hermesAuthMethodError).toContain("cannot determine");
  });

  it("does not borrow Hermes auth from a same-name conflicting selection", () => {
    const config = resolveRebuildDurableConfig(
      "alpha",
      {
        name: "alpha",
        provider: "hermes-provider",
        model: "target",
        nemoclawVersion: "0.1.0",
      },
      createSession({
        sandboxName: "alpha",
        provider: "hermes-provider",
        model: "different",
        hermesAuthMethod: "oauth",
      }),
    );
    expect(config.hermesAuthMethod).toBeNull();
    expect(config.hermesAuthMethodError).toContain("cannot determine");
  });
});

describe("Hermes operator config rebuild handoff", () => {
  const liveConfig: ConfigObject = {
    _config_version: 33,
    _nemoclaw_upstream: {
      provider: "compatible-endpoint",
      provider_key: "compatible-endpoint",
      model: "llama3.2:1b",
    },
    model: {
      default: "llama3.2:1b",
      provider: "custom",
      base_url: "https://inference.local/v1",
      api_key: "sentinel",
      max_tokens: 24576,
    },
    providers: {
      "compatible-endpoint": {
        name: "compatible-endpoint",
        api: "https://inference.local/v1",
        api_key: "sentinel",
        default_model: "llama3.2:1b",
        discover_models: true,
        stale_timeout_seconds: 181,
        request_timeout_seconds: 182,
      },
    },
    memory: { provider: "hindsight" },
    delegation: {
      model: "compatible-endpoint/llama3.2:1b",
      child_timeout_seconds: 183,
    },
    approvals: { mode: "manual", timeout: 184 },
    security: { allow_private_urls: true },
    custom_providers: [
      {
        name: "compatible-endpoint",
        base_url: "https://inference.local/v1",
        api_key: "sentinel",
        discover_models: true,
      },
      {
        name: "operator-extra",
        base_url: "http://192.0.2.10/v1",
        discover_models: false,
      },
    ],
    operator_issue_10495: { enabled: true, label: "preserve-rebuild" },
  };

  const contractKeys = [
    "memory.provider",
    "model.max_tokens",
    "providers.compatible-endpoint.stale_timeout_seconds",
    "providers.compatible-endpoint.request_timeout_seconds",
    "delegation.model",
    "delegation.child_timeout_seconds",
    "approvals.timeout",
    "security.allow_private_urls",
    "custom_providers",
    "operator_issue_10495",
    "model.default",
  ];

  it("captures every audited non-route value and marks a managed route key dropped", () => {
    const snapshot = captureHermesOperatorConfigSnapshotFromConfig(
      "hermes",
      liveConfig,
      contractKeys,
    );

    expect(snapshot.entries.map((entry) => entry.key)).toEqual(contractKeys.slice(0, -1).sort());
    expect(snapshot.droppedKeys).toEqual(["model.default"]);
    expect(snapshot.entries.find((entry) => entry.key === "custom_providers")?.value).toEqual([
      {
        name: "operator-extra",
        base_url: "http://192.0.2.10/v1",
        discover_models: false,
      },
    ]);
  });

  it("derives the managed provider key when the upstream marker omits it", () => {
    const config: ConfigObject = structuredClone(liveConfig);
    config._nemoclaw_upstream = {
      provider: "Compatible Endpoint",
      model: "llama3.2:1b",
    };
    config.providers = {
      "compatible-endpoint": {
        name: "compatible-endpoint",
        api_key: "managed-sentinel",
        request_timeout_seconds: 182,
      },
    };

    const snapshot = captureHermesOperatorConfigSnapshotFromConfig("hermes", config, [
      "providers.compatible-endpoint",
    ]);

    expect(snapshot).toEqual({
      version: 1,
      sandboxName: "hermes",
      entries: [
        {
          key: "providers.compatible-endpoint",
          value: { request_timeout_seconds: 182 },
        },
      ],
      droppedKeys: [],
    });
    expect(JSON.stringify(snapshot)).not.toContain("managed-sentinel");
  });

  it("merges operator values over a fresh route and verifies restored and dropped keys", () => {
    const snapshot = captureHermesOperatorConfigSnapshotFromConfig(
      "hermes",
      liveConfig,
      contractKeys,
    );
    const fresh: ConfigObject = {
      _nemoclaw_upstream: {
        provider: "compatible-endpoint",
        provider_key: "compatible-endpoint",
        model: "new-model",
      },
      model: {
        default: "new-model",
        provider: "custom",
        base_url: "https://inference.local/v1",
        api_key: "fresh-sentinel",
      },
      providers: {
        "compatible-endpoint": {
          name: "compatible-endpoint",
          api: "https://inference.local/v1",
          api_key: "fresh-sentinel",
          default_model: "new-model",
          discover_models: true,
        },
      },
      custom_providers: [
        {
          name: "compatible-endpoint",
          base_url: "https://inference.local/v1",
          api_key: "fresh-sentinel",
          discover_models: true,
        },
      ],
    };

    const merged = applyHermesOperatorConfigSnapshot(fresh, snapshot);
    expect((merged.model as ConfigObject).default).toBe("new-model");
    expect((merged.model as ConfigObject).max_tokens).toBe(24576);
    expect(merged.custom_providers).toHaveLength(2);
    expect(verifyHermesOperatorConfigSnapshot(merged, snapshot)).toEqual({
      restoredKeys: contractKeys.slice(0, -1).sort(),
      droppedKeys: ["model.default"],
    });
  });

  it("rejects unsupported paths from a tampered handoff before merge", () => {
    const document = JSON.stringify({
      version: 1,
      sandboxName: "hermes",
      entries: [{ key: "gateway.authToken", value: "unsafe" }],
      droppedKeys: [],
    });
    expect(parseHermesOperatorConfigSnapshot(document, "hermes")).toBeNull();
    expect(
      parseHermesOperatorConfigSnapshot(
        JSON.stringify({
          version: 1,
          sandboxName: "hermes",
          entries: [],
          droppedKeys: ["gateway.authToken"],
        }),
        "hermes",
      ),
    ).toEqual({
      version: 1,
      sandboxName: "hermes",
      entries: [],
      droppedKeys: ["gateway.authToken"],
    });
    expect(() =>
      captureHermesOperatorConfigSnapshotFromConfig("hermes", liveConfig, ["custom_providers.0"]),
    ).toThrow("unsupported Hermes operator config key");
  });

  it("reads audited config-set keys and round-trips a bounded snapshot", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-10495-audit-"));
    try {
      const auditFile = path.join(dir, "shields-audit.jsonl");
      fs.writeFileSync(
        auditFile,
        [
          JSON.stringify({
            action: "config_set",
            sandbox: "hermes",
            reason: "config set hermes:model.max_tokens",
          }),
          JSON.stringify({
            action: "config_set",
            sandbox: "other",
            reason: "config set hermes:memory.provider",
          }),
          JSON.stringify({
            action: "config_set",
            sandbox: "hermes",
            reason: "config set hermes:gateway.authToken",
          }),
        ].join("\n"),
      );
      const snapshot = captureHermesOperatorConfigSnapshot("hermes", {
        auditFile,
        resolveConfig: () => ({ agentName: "hermes" }) as never,
        readConfig: () => liveConfig,
      });
      const document = serializeHermesOperatorConfigSnapshot(snapshot);
      expect(parseHermesOperatorConfigSnapshot(document, "hermes")).toEqual(snapshot);
      expect(parseHermesOperatorConfigSnapshot(document, "other")).toBeNull();
      expect(snapshot.entries).toEqual([{ key: "model.max_tokens", value: 24576 }]);
      expect(snapshot.droppedKeys).toEqual(["gateway.authToken"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("requires distinct array entries when it verifies duplicate operator values", () => {
    const snapshot = {
      version: 1 as const,
      sandboxName: "hermes",
      entries: [{ key: "operator_issue_10495.values", value: ["same", "same"] }],
      droppedKeys: [],
    };

    expect(
      verifyHermesOperatorConfigSnapshot({ operator_issue_10495: { values: ["same"] } }, snapshot),
    ).toEqual({
      restoredKeys: [],
      droppedKeys: ["operator_issue_10495.values"],
    });
    expect(
      verifyHermesOperatorConfigSnapshot(
        { operator_issue_10495: { values: ["same", "same"] } },
        snapshot,
      ),
    ).toEqual({
      restoredKeys: ["operator_issue_10495.values"],
      droppedKeys: [],
    });
  });

  it("reassigns an ambiguous array match without exponential backtracking", () => {
    const snapshot = {
      version: 1 as const,
      sandboxName: "hermes",
      entries: [
        {
          key: "operator_issue_10495.values",
          value: [{}, { name: "specific" }],
        },
      ],
      droppedKeys: [],
    };

    expect(
      verifyHermesOperatorConfigSnapshot(
        {
          operator_issue_10495: {
            values: [{ name: "specific" }, { name: "other" }],
          },
        },
        snapshot,
      ),
    ).toEqual({
      restoredKeys: ["operator_issue_10495.values"],
      droppedKeys: [],
    });
  });
});

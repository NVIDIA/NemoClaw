// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Validate blueprint.yaml profile declarations and base sandbox policy.
 *
 * Catches configuration regressions (missing profiles, empty fields,
 * missing policy sections) before merge.
 */

import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import YAML from "yaml";

const BLUEPRINT_PATH = new URL("../nemoclaw-blueprint/blueprint.yaml", import.meta.url);
const BASE_POLICY_PATH = new URL(
  "../nemoclaw-blueprint/policies/openclaw-sandbox.yaml",
  import.meta.url,
);
const PERMISSIVE_POLICY_PATH = new URL(
  "../nemoclaw-blueprint/policies/openclaw-sandbox-permissive.yaml",
  import.meta.url,
);
const REQUIRED_PROFILE_FIELDS: ReadonlyArray<keyof BlueprintProfile> = [
  "provider_type",
  "endpoint",
];

type BlueprintProfile = {
  provider_type?: string;
  endpoint?: string;
  dynamic_endpoint?: boolean;
};

type Blueprint = {
  version?: string;
  digest?: string;
  profiles?: string[];
  components?: {
    sandbox?: { image?: string | null };
    inference?: { profiles?: Record<string, BlueprintProfile> };
  };
};

type Rule = { allow?: { method?: string; path?: string } };
type Endpoint = {
  host?: string;
  port?: number;
  protocol?: string;
  enforcement?: string;
  access?: string;
  tls?: string;
  websocket_credential_rewrite?: boolean;
  request_body_credential_rewrite?: boolean;
  rules?: Rule[];
  binaries?: Array<{ path: string }>;
};

type PolicyEntry = {
  name?: string;
  endpoints?: Endpoint[];
  binaries?: Array<{ path: string }>;
};

type SandboxPolicy = {
  version?: number;
  network_policies?: Record<string, PolicyEntry>;
};

type PolicyPreset = {
  preset?: { name?: string; description?: string };
  network_policies?: Record<string, PolicyEntry>;
};

function loadYaml<T>(path: URL): T {
  return YAML.parse(readFileSync(path, "utf-8"));
}

const bp = loadYaml<Blueprint>(BLUEPRINT_PATH);
const declared = Array.isArray(bp.profiles) ? bp.profiles : [];
const defined = bp.components?.inference?.profiles;

describe("blueprint.yaml", () => {
  it("parses as a YAML mapping", () => {
    expect(bp).toEqual(expect.objectContaining({}));
  });

  it("has a non-empty top-level profiles list", () => {
    expect(declared.length).toBeGreaterThan(0);
  });

  it("has a non-empty components.inference.profiles mapping", () => {
    expect(defined).toBeDefined();
    expect(Object.keys(defined ?? {}).length).toBeGreaterThan(0);
  });

  it("regression #1438: sandbox image is pinned by digest, not by mutable tag", () => {
    // The blueprint MUST NOT pull a sandbox image by a mutable tag like
    // ":latest" — a registry compromise or accidental force-push could
    // silently swap the image. Pin via @sha256:... so the image cannot
    // change without a corresponding blueprint update.
    const sandbox = bp.components?.sandbox;
    const image = typeof sandbox?.image === "string" ? sandbox.image : "";
    expect(image.length).toBeGreaterThan(0);
    expect(image).toContain("@sha256:");
    // Belt and braces: explicitly forbid the ":latest" tag form even if the
    // image string has been rearranged.
    expect(image).not.toMatch(/:latest$/);
    expect(image).not.toMatch(/:latest@/);
    // The digest itself must be a 64-hex sha256.
    const digestMatch = image.match(/@sha256:([0-9a-f]{64})$/);
    expect(digestMatch).not.toBeNull();
  });

  it("regression #1438: top-level digest field is populated and matches the image digest", () => {
    // The top-level `digest:` field at the top of blueprint.yaml is
    // documented as "Computed at release time" and was empty on main,
    // which left blueprint-level integrity unverifiable. Mirror the
    // sandbox image manifest digest into the top-level field so any
    // consumer can read a single field to know what's pinned, and so
    // a future contributor can't bump one without bumping the other.
    const topLevelDigest = typeof bp.digest === "string" ? bp.digest : "";
    expect(topLevelDigest.length).toBeGreaterThan(0);
    // Must be a sha256:<64-hex> string.
    expect(topLevelDigest).toMatch(/^sha256:[0-9a-f]{64}$/);

    const sandbox = bp.components?.sandbox;
    const image = typeof sandbox?.image === "string" ? sandbox.image : "";
    const imageDigestMatch = image.match(/@sha256:([0-9a-f]{64})$/);
    expect(imageDigestMatch).not.toBeNull();
    const imageDigest = `sha256:${imageDigestMatch?.[1] ?? ""}`;

    // The two digests must agree. If a future bump touches one but not
    // the other, this assertion catches it before merge.
    expect(topLevelDigest).toBe(imageDigest);
  });

  for (const name of declared) {
    describe(`profile '${name}'`, () => {
      it("has a definition", () => {
        expect(defined).toBeDefined();
        expect(name in (defined ?? {})).toBe(true);
      });

      for (const field of REQUIRED_PROFILE_FIELDS) {
        it(`has non-empty '${field}'`, () => {
          const cfg = defined?.[name];
          if (!cfg) return; // covered by "has a definition"
          if (field === "endpoint" && cfg.dynamic_endpoint === true) {
            expect(field in cfg).toBe(true);
          } else {
            expect(cfg[field]).toBeTruthy();
          }
        });
      }
    });
  }

  for (const name of Object.keys(defined ?? {})) {
    it(`defined profile '${name}' is declared in top-level list`, () => {
      expect(declared).toContain(name);
    });
  }
});

describe("base sandbox policy", () => {
  const policy = loadYaml<SandboxPolicy>(BASE_POLICY_PATH);

  it("parses as a YAML mapping", () => {
    expect(policy).toEqual(expect.objectContaining({}));
  });

  it("has 'version'", () => {
    expect("version" in policy).toBe(true);
  });

  it("has 'network_policies'", () => {
    expect("network_policies" in policy).toBe(true);
  });

  it("no endpoint rule uses wildcard method", () => {
    const np = policy.network_policies ?? {};
    const violations: string[] = [];
    for (const [policyName, cfg] of Object.entries(np)) {
      const endpoints = cfg.endpoints;
      if (!endpoints) continue;
      for (const ep of endpoints) {
        const rules = ep.rules;
        if (!rules) continue;
        for (const rule of rules) {
          const method = rule.allow?.method;
          if (method === "*") {
            violations.push(`${policyName} → ${ep.host}: method "*"`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("every endpoint with rules has protocol: rest and enforcement: enforce", () => {
    const np = policy.network_policies ?? {};
    const violations: string[] = [];
    for (const [policyName, cfg] of Object.entries(np)) {
      const endpoints = cfg.endpoints;
      if (!endpoints) continue;
      for (const ep of endpoints) {
        if (!ep.rules) continue;
        if (ep.protocol !== "rest") {
          violations.push(`${policyName} → ${ep.host}: missing protocol: rest`);
        }
        if (ep.enforcement !== "enforce") {
          violations.push(`${policyName} → ${ep.host}: missing enforcement: enforce`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("allows NVIDIA embeddings on both NVIDIA inference hosts", () => {
    const np = policy.network_policies ?? {};
    const endpoints = np.nvidia?.endpoints;
    const missingHosts: string[] = [];
    for (const host of ["integrate.api.nvidia.com", "inference-api.nvidia.com"]) {
      const endpoint = endpoints?.find((entry) => entry.host === host);
      const hasEmbeddingsRule = endpoint?.rules?.some(
        (rule) => rule.allow?.method === "POST" && rule.allow?.path === "/v1/embeddings",
      );
      if (!hasEmbeddingsRule) {
        missingHosts.push(host);
      }
    }
    expect(missingHosts).toEqual([]);
  });

  // Walk every endpoint in every network_policies entry and return the
  // entries whose host matches `hostMatcher`. Used by the regressions below.
  function findEndpoints(hostMatcher: (h: string) => boolean): Endpoint[] {
    const out: Endpoint[] = [];
    const np = policy.network_policies;
    if (!np) return out;
    for (const value of Object.values(np)) {
      const endpoints = value.endpoints;
      if (!Array.isArray(endpoints)) continue;
      for (const ep of endpoints) {
        if (typeof ep.host === "string" && hostMatcher(ep.host)) {
          out.push(ep);
        }
      }
    }
    return out;
  }

  it("regression #1437: base policy does not expose sentry.io by default", () => {
    const sentryEndpoints = findEndpoints((h) => h === "sentry.io");
    expect(sentryEndpoints).toEqual([]);
  });

  it("regression #1583: base policy does not silently grant GitHub access", () => {
    // Until #1583, github.com / api.github.com plus the git/gh
    // binaries lived in network_policies and were therefore included
    // in every sandbox regardless of user opt-in. The fix moves the
    // entry into a discoverable preset (`presets/github.yaml`). This
    // assertion blocks the regression where someone re-adds a github
    // entry to the base policy and silently re-grants every sandbox
    // unscoped GitHub access.
    const np = policy.network_policies;
    expect(np && "github" in np).toBe(false);

    // Belt and braces: also assert no endpoint in any base-policy
    // entry references github.com or api.github.com, so the
    // regression can't be smuggled in under a renamed key.
    const githubHosts = findEndpoints((h) => h === "github.com" || h === "api.github.com");
    expect(githubHosts).toEqual([]);
  });

  it("regression #2663: managed_inference policy allows inference.local:443 GET and POST", () => {
    // inference.local is the OpenShell gateway's managed inference virtual
    // hostname — the gateway proxies it to the configured provider (OpenAI,
    // NVIDIA, etc.). Every sandbox uses this route regardless of provider.
    // Without this entry the OpenShell proxy blocks url-fetch calls to
    // https://inference.local/v1/... with "Blocked hostname or
    // private/internal/special-use IP address", breaking all inference.
    const np = policy.network_policies ?? {};
    expect(np.managed_inference).toBeDefined();
    const endpoints = np.managed_inference?.endpoints ?? [];
    const inferenceEp = endpoints.find((ep) => ep.host === "inference.local");
    expect(inferenceEp).toBeDefined();
    expect(inferenceEp?.port).toBe(443);
    const rules = inferenceEp?.rules ?? [];
    const hasGet = rules.some(
      (r) => r.allow?.method?.toUpperCase() === "GET" && r.allow?.path === "/**",
    );
    const hasPost = rules.some(
      (r) => r.allow?.method?.toUpperCase() === "POST" && r.allow?.path === "/**",
    );
    expect(hasGet).toBe(true);
    expect(hasPost).toBe(true);
  });

  it("regression #2663: managed_inference allows openclaw and tool binaries", () => {
    const np = policy.network_policies ?? {};
    const binaries = (np.managed_inference?.binaries ?? []).map((b) => b.path).sort();
    expect(binaries).toEqual([
      "/usr/bin/curl",
      "/usr/bin/node",
      "/usr/bin/python3",
      "/usr/local/bin/node",
      "/usr/local/bin/openclaw",
    ]);
  });

  it("does not reference the absent Claude CLI binary", () => {
    const serialized = JSON.stringify(policy.network_policies ?? {});
    expect(serialized).not.toContain("/usr/local/bin/claude");
  });

  it("regression #2180: base policy does not silently grant Telegram access", () => {
    // Until #1705 (later regressed by #1700 and re-surfaced in #2180),
    // `api.telegram.org` plus a /usr/local/bin/node binary lived in the
    // base network_policies, so every sandbox could call the Telegram
    // Bot API regardless of whether the user selected the telegram
    // messaging channel or policy preset. The fix keeps Telegram access
    // inside `presets/telegram.yaml`. This assertion blocks a regression
    // where someone re-adds a telegram entry to the base policy and
    // silently re-grants every sandbox unscoped Telegram access.
    const np = policy.network_policies as Record<string, unknown> | undefined;
    expect(np && typeof np === "object" && "telegram" in np).toBe(false);

    const telegramHosts = findEndpoints((h) => h === "api.telegram.org");
    expect(telegramHosts).toEqual([]);
  });

  it("regression #2180: base policy does not silently grant Discord access", () => {
    // Parallel to the Telegram regression above. Discord (discord.com,
    // gateway.discord.gg, cdn.discordapp.com, media.discordapp.net) is
    // the opt-in preset path, not baseline. Re-adding these endpoints
    // to the base policy lets any sandbox reach Discord without the
    // user having selected the discord messaging channel or preset.
    const np = policy.network_policies as Record<string, unknown> | undefined;
    expect(np && typeof np === "object" && "discord" in np).toBe(false);

    const discordHosts = findEndpoints(
      (h) =>
        h === "discord.com" ||
        h === "gateway.discord.gg" ||
        h === "*.discord.gg" ||
        h === "cdn.discordapp.com" ||
        h === "media.discordapp.net",
    );
    expect(discordHosts).toEqual([]);
  });

  it("regression #2180: base policy does not silently grant Slack access", () => {
    // Slack was never in the baseline, but guard against it being added
    // in the same merge-conflict-resolution pattern that re-added
    // Telegram and Discord after #1705. Slack access is in
    // presets/slack.yaml only.
    const np = policy.network_policies as Record<string, unknown> | undefined;
    expect(np && typeof np === "object" && "slack" in np).toBe(false);

    const slackHosts = findEndpoints(
      (h) =>
        h === "slack.com" ||
        h.endsWith(".slack.com") ||
        h === "wss-primary.slack.com" ||
        h === "wss-backup.slack.com",
    );
    expect(slackHosts).toEqual([]);
  });

  it("regression #1458: baseline npm_registry must not include npm or node binaries", () => {
    const np = policy.network_policies ?? {};
    const npmRegistry = np.npm_registry;
    expect(npmRegistry).toBeDefined();
    const binaries = npmRegistry?.binaries;
    expect(Array.isArray(binaries)).toBe(true);
    const paths = (binaries ?? []).map((b) => b.path).sort();
    // Only openclaw CLI should reach the npm registry by default.
    // npm/node being in this list lets the agent bypass 'none' policy preset.
    // Exact allowlist — adding any binary here requires a deliberate review.
    expect(paths).toEqual(["/usr/local/bin/openclaw"]);
  });
});

describe("permissive sandbox policy", () => {
  // openclaw-sandbox-permissive.yaml is applied by `shields down --policy
  // permissive`. It must carry forward the gateway-managed inference route
  // so the mental model stays consistent with the base policy and so we
  // don't silently depend on OpenShell's implicit allow for
  // gateway-bound virtual hostnames.
  // Ref: https://github.com/NVIDIA/NemoClaw/issues/2513, #2663
  const policy = loadYaml<SandboxPolicy>(PERMISSIVE_POLICY_PATH);

  it("parses and declares network_policies", () => {
    expect(policy.network_policies).toBeDefined();
  });

  it("regression #2513: managed_inference block allows inference.local:443", () => {
    const np = policy.network_policies ?? {};
    expect(np.managed_inference).toBeDefined();
    const endpoints = np.managed_inference?.endpoints ?? [];
    const inferenceEp = endpoints.find((ep) => ep.host === "inference.local");
    expect(inferenceEp).toBeDefined();
    expect(inferenceEp?.port).toBe(443);
    // Permissive policy uses the `access: full` convention (any method, any
    // path) rather than explicit per-method rules. That is consistent with
    // every other host in this file.
    expect(inferenceEp?.access).toBe("full");
    expect(inferenceEp?.enforcement).toBe("enforce");
  });

  it("regression #2513: managed_inference uses permissive '/**' binary allowlist", () => {
    const np = policy.network_policies ?? {};
    const binaries = (np.managed_inference?.binaries ?? []).map((b) => b.path);
    // Matches the permissive-file convention used by every other block
    // (e.g. `nvidia`, `github`, `huggingface`, etc.).
    expect(binaries).toEqual(["/**"]);
  });
});

describe("github preset", () => {
  // The fix for #1583 was *only* meaningful if the github preset
  // actually exists and is loadable — otherwise users have no way to
  // opt in. Verify the preset file is present and well-formed.
  const PRESET_PATH = new URL(
    "../nemoclaw-blueprint/policies/presets/github.yaml",
    import.meta.url,
  );

  it("regression #1583: github preset file exists and parses", () => {
    const parsed = loadYaml<PolicyPreset>(PRESET_PATH);
    expect(parsed).toEqual(expect.objectContaining({}));
    const meta = parsed.preset;
    expect(meta?.name).toBe("github");
    const np = parsed.network_policies;
    expect(np && "github" in np).toBe(true);
  });

  it("regression #2179: github preset only advertises the installed git binary", () => {
    const parsed = loadYaml<PolicyPreset>(PRESET_PATH);
    const meta = parsed.preset;
    expect(meta?.description).toBe("GitHub.com and GitHub API access (git)");
    expect(meta?.description ?? "").not.toMatch(/\bgh\b/);

    const binaries = (parsed.network_policies?.github?.binaries ?? [])
      .map((binary) => binary.path)
      .sort();
    expect(binaries).toEqual(["/usr/bin/git"]);
  });
});

describe("huggingface preset", () => {
  // The huggingface preset used to allow POST /** on huggingface.co,
  // which let an agent that found an HF token in the environment
  // publish models, datasets, and create repositories via
  // /api/repos/create and friends. Inference Provider traffic flows
  // through router.huggingface.co, not huggingface.co, so the POST
  // rule was never required for read-only `from_pretrained` flows.
  // The fix removes the POST rule from huggingface.co (download-only).
  // These tests block a regression where someone re-adds it.
  // See #1432.
  const HUGGINGFACE_PRESET_PATH = new URL(
    "../nemoclaw-blueprint/policies/presets/huggingface.yaml",
    import.meta.url,
  );
  const huggingfacePreset = loadYaml<PolicyPreset>(HUGGINGFACE_PRESET_PATH);

  function presetEndpoints(): Endpoint[] {
    const np = huggingfacePreset.network_policies;
    if (!np) return [];
    const hf = np.huggingface;
    return Array.isArray(hf?.endpoints) ? hf.endpoints : [];
  }

  it("regression #1432: huggingface.co has no POST allow rule", () => {
    const endpoints = presetEndpoints().filter((ep) => ep.host === "huggingface.co");
    expect(endpoints.length).toBeGreaterThan(0);
    for (const ep of endpoints) {
      const rules = Array.isArray(ep.rules) ? ep.rules : [];
      const hasPost = rules.some(
        (r) =>
          r &&
          r.allow &&
          typeof r.allow.method === "string" &&
          r.allow.method.toUpperCase() === "POST",
      );
      expect(hasPost).toBe(false);
    }
  });

  it("regression #1432: huggingface.co retains GET so downloads still work", () => {
    const endpoints = presetEndpoints().filter((ep) => ep.host === "huggingface.co");
    for (const ep of endpoints) {
      const rules = Array.isArray(ep.rules) ? ep.rules : [];
      const hasGet = rules.some(
        (r) =>
          r &&
          r.allow &&
          typeof r.allow.method === "string" &&
          r.allow.method.toUpperCase() === "GET",
      );
      expect(hasGet).toBe(true);
    }
  });
});

describe("messaging WebSocket presets", () => {
  const DISCORD_PRESET_PATH = new URL(
    "../nemoclaw-blueprint/policies/presets/discord.yaml",
    import.meta.url,
  );
  const SLACK_PRESET_PATH = new URL(
    "../nemoclaw-blueprint/policies/presets/slack.yaml",
    import.meta.url,
  );

  const presets = [
    {
      name: "discord",
      policyKey: "discord",
      host: "gateway.discord.gg",
      credentialRewrite: true,
      data: loadYaml<PolicyPreset>(DISCORD_PRESET_PATH),
    },
    {
      name: "discord",
      policyKey: "discord",
      host: "*.discord.gg",
      credentialRewrite: true,
      data: loadYaml<PolicyPreset>(DISCORD_PRESET_PATH),
    },
    {
      name: "slack",
      policyKey: "slack",
      host: "wss-primary.slack.com",
      credentialRewrite: true,
      data: loadYaml<PolicyPreset>(SLACK_PRESET_PATH),
    },
    {
      name: "slack",
      policyKey: "slack",
      host: "wss-backup.slack.com",
      credentialRewrite: true,
      data: loadYaml<PolicyPreset>(SLACK_PRESET_PATH),
    },
  ];

  for (const preset of presets) {
    it(`${preset.name} ${preset.host} uses native WebSocket inspection`, () => {
      const endpoints = preset.data.network_policies?.[preset.policyKey]?.endpoints ?? [];
      const endpoint = endpoints.find((candidate) => candidate.host === preset.host);
      expect(endpoint).toBeDefined();
      expect(endpoint).toMatchObject({ protocol: "websocket", enforcement: "enforce" });
      expect(endpoint).not.toHaveProperty("access");
      expect(endpoint).not.toHaveProperty("tls");
      expect(endpoint?.websocket_credential_rewrite === true).toBe(preset.credentialRewrite);
      expect(endpoint?.rules).toEqual(
        expect.arrayContaining([
          { allow: { method: "GET", path: "/**" } },
          { allow: { method: "WEBSOCKET_TEXT", path: "/**" } },
        ]),
      );
    });
  }
});

describe("Slack REST credential rewrite", () => {
  const SLACK_PRESET_PATH = new URL(
    "../nemoclaw-blueprint/policies/presets/slack.yaml",
    import.meta.url,
  );
  const data = loadYaml<PolicyPreset>(SLACK_PRESET_PATH);
  const slackRestHosts = ["slack.com", "api.slack.com", "hooks.slack.com"];

  for (const host of slackRestHosts) {
    it(`${host} enables request-body credential rewrite`, () => {
      const endpoints = data.network_policies?.slack?.endpoints ?? [];
      const endpoint = endpoints.find((candidate) => candidate.host === host);
      expect(endpoint).toBeDefined();
      expect(endpoint).toMatchObject({
        protocol: "rest",
        enforcement: "enforce",
        request_body_credential_rewrite: true,
      });
    });
  }
});

describe("npm preset", () => {
  // Regression #2767: npm/Yarn registry endpoints used `protocol: rest`
  // with only GET allowed. Node 22 undici issues HTTP CONNECT through
  // HTTPS_PROXY for TLS tunneling; the L7 proxy rejects parallel CONNECT
  // tunnels, causing NET:FAIL and ECONNRESET on tarball downloads.
  // The fix switches to L4 tunnel mode.
  const NPM_PRESET_PATH = new URL(
    "../nemoclaw-blueprint/policies/presets/npm.yaml",
    import.meta.url,
  );
  const npmPreset = loadYaml<PolicyPreset>(NPM_PRESET_PATH);

  function npmEndpoints(): Endpoint[] {
    const np = npmPreset.network_policies;
    if (!np) return [];
    const entry = np.npm_yarn;
    return Array.isArray(entry?.endpoints) ? entry.endpoints : [];
  }

  const REGISTRY_HOSTS = ["registry.npmjs.org", "registry.yarnpkg.com"];

  for (const host of REGISTRY_HOSTS) {
    it(`regression #2767: ${host} uses L4 tunnel (access: full, tls: skip) for CONNECT compatibility`, () => {
      const endpoints = npmEndpoints().filter((ep) => ep.host === host);
      expect(endpoints.length).toBeGreaterThan(0);
      for (const ep of endpoints) {
        expect(ep.access).toBe("full");
        expect(ep).toHaveProperty("tls", "skip");
        // Must NOT use protocol: rest — that triggers L7 method inspection
        // which rejects CONNECT tunnels from Node 22 undici.
        expect(ep).not.toHaveProperty("protocol");
        expect(ep).not.toHaveProperty("rules");
      }
    });
  }
});

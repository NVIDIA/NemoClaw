// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Functional tests for agents/hermes/seed-dashboard-config.py.
// Runs the actual Python script against temp config files and asserts on the
// on-disk YAML it leaves behind. Mirrors the spawn-and-read pattern from
// seed-wechat-accounts.test.ts and generate-hermes-config.test.ts.
//
// The Hermes dashboard runs under its own HERMES_HOME, so it never sees the
// model/custom_providers block NemoClaw writes to the gateway config. This
// script mirrors those routing keys and reviewed policy leaves into the
// dashboard config so the Models page and kanban specifier/dispatcher resolve
// the routed model without falling back to unsafe or privacy-expanding defaults.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import type { HermesBuildSettings } from "../../../agents/hermes/config/build-env.ts";
import { buildHermesManagedPolicy } from "../../../agents/hermes/config/managed-policy.ts";

const SCRIPT_PATH = path.join(
  import.meta.dirname,
  "../../..",
  "agents",
  "hermes",
  "seed-dashboard-config.py",
);

// PyYAML ships in the Hermes venv at runtime; CI/dev hosts generally have it too.
// Skip gracefully (rather than fail spuriously) where python3 or PyYAML is absent.
const PY_YAML_AVAILABLE =
  spawnSync("python3", ["-c", "import yaml"], { stdio: "ignore" }).status === 0;
const GENERATED_HEX_TOKEN = Array.from({ length: 64 }, (_value, index) =>
  (index % 16).toString(16),
).join("");
const TAVILY_API_KEY_PLACEHOLDER = "openshell:resolve:env:TAVILY_API_KEY";

const POLICY_SETTINGS: HermesBuildSettings = {
  model: "nvidia-routed",
  baseUrl: "https://inference.local/v1",
  providerKey: "nvidia-router",
  upstreamProvider: "nvidia-router",
  inferenceApi: "anthropic-messages",
  contextWindow: null,
  toolDisclosure: "progressive",
  webSearchProvider: "tavily",
  messagingCredentialPlaceholders: [],
  managedToolGateways: { brokerEnabled: false, presets: [] },
  managedImageCapabilityUnion: false,
};
const MANAGED_POLICY = buildHermesManagedPolicy(POLICY_SETTINGS, {});
const EXPECTED_DASHBOARD_POLICY = {
  approvals: { mode: "manual" },
  browser: { allow_unsafe_evaluate: false, restrict_evaluate: true },
  session_reset: {
    mode: "both",
    at_hour: 4,
    idle_minutes: 1440,
    notify: true,
    notify_exclude_platforms: ["api_server", "webhook"],
    bg_process_max_age_hours: 24,
  },
  display: { show_reasoning: false, show_commentary: false },
  updates: { pre_update_backup: false, refresh_cua_driver: false },
};
const GATEWAY_POLICY = Object.fromEntries(
  Array.from(
    new Set(MANAGED_POLICY.managed_paths.map((path) => path.split(".", 1)[0])),
    (section) => [section, MANAGED_POLICY.config[section]],
  ),
);

const GATEWAY_CONFIG = {
  _config_version: 12,
  _nemoclaw_upstream: {
    provider: "nvidia-router",
    provider_key: "nvidia-router",
    model: "nvidia-routed",
  },
  model: {
    default: "nvidia-routed",
    provider: "custom",
    base_url: "https://inference.local/v1",
    api_key: "sk-OPENSHELL-PROXY-REWRITE",
    api_mode: "anthropic_messages",
  },
  providers: {
    "nvidia-router": {
      name: "nvidia-router",
      api: "https://inference.local/v1",
      api_key: "sk-OPENSHELL-PROXY-REWRITE",
      default_model: "nvidia-routed",
      discover_models: true,
      transport: "anthropic_messages",
    },
  },
  custom_providers: [
    {
      name: "nvidia-router",
      base_url: "https://inference.local/v1",
      api_key: "sk-OPENSHELL-PROXY-REWRITE",
      discover_models: true,
      api_mode: "anthropic_messages",
    },
  ],
  // Intentionally present to assert it is NOT mirrored (would collide with the
  // gateway's api_server bind).
  platforms: { api_server: { enabled: true, extra: { port: 18642 } } },
  web: { backend: "tavily" },
  ...GATEWAY_POLICY,
};

let tmpDir: string;
let policyPath: string;

function runSeed(
  srcPath: string,
  dstPath: string,
  envSrcPath?: string,
  envDstPath?: string,
  env: Record<string, string | undefined> = {},
  mergeLegacy = false,
) {
  const envArgs = envSrcPath && envDstPath ? [envSrcPath, envDstPath] : [];
  const args = [
    SCRIPT_PATH,
    ...(mergeLegacy ? ["--merge-legacy"] : []),
    policyPath,
    srcPath,
    dstPath,
    ...envArgs,
  ];
  return spawnSync("python3", args, {
    encoding: "utf-8",
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 10_000,
  });
}

function writeYaml(name: string, value: unknown): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, YAML.stringify(value));
  return p;
}

function readYaml(p: string): Record<string, unknown> {
  const parsed = YAML.parse(fs.readFileSync(p, "utf-8"));
  expect(parsed, `${p} should contain a YAML object`).toBeTruthy();
  expect(typeof parsed, `${p} should contain a YAML object`).toBe("object");
  expect(Array.isArray(parsed), `${p} should contain a YAML object`).toBe(false);
  return parsed as Record<string, unknown>;
}

describe.skipIf(!PY_YAML_AVAILABLE)("seed-dashboard-config.py", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "seed-dash-"));
    policyPath = path.join(tmpDir, "managed-policy.json");
    fs.writeFileSync(policyPath, `${JSON.stringify(MANAGED_POLICY)}\n`);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates a new dashboard config with the gateway's routing keys", () => {
    const src = writeYaml("gw.yaml", GATEWAY_CONFIG);
    const dst = path.join(tmpDir, "dash.yaml");

    const res = runSeed(src, dst);
    expect(res.status).toBe(0);

    const dash = readYaml(dst);
    expect(dash.model).toEqual({ ...GATEWAY_CONFIG.model, provider: "nvidia-router" });
    expect(dash.providers).toEqual(GATEWAY_CONFIG.providers);
    expect(dash.custom_providers).toEqual(GATEWAY_CONFIG.custom_providers);
    expect(dash._nemoclaw_upstream).toEqual(GATEWAY_CONFIG._nemoclaw_upstream);
    expect(dash.approvals).toEqual(EXPECTED_DASHBOARD_POLICY.approvals);
    expect(dash.browser).toEqual(EXPECTED_DASHBOARD_POLICY.browser);
    expect(dash.session_reset).toEqual(EXPECTED_DASHBOARD_POLICY.session_reset);
    expect(dash.display).toEqual(EXPECTED_DASHBOARD_POLICY.display);
    expect(dash.updates).toEqual(EXPECTED_DASHBOARD_POLICY.updates);
  });

  it("moves the legacy dashboard home into the Hermes profiles directory (#7200)", () => {
    const src = writeYaml("gw.yaml", GATEWAY_CONFIG);
    const hermesHome = path.join(tmpDir, ".hermes");
    const legacyHome = path.join(hermesHome, "dashboard-home");
    const dashboardHome = path.join(hermesHome, "profiles", "dashboard-home");
    fs.mkdirSync(legacyHome, { recursive: true });
    fs.chmodSync(legacyHome, 0o770);
    fs.writeFileSync(path.join(legacyHome, "MEMORY.md"), "keep me\n");

    const res = runSeed(src, path.join(dashboardHome, "config.yaml"));

    expect(res.status).toBe(0);
    expect(res.stderr).toContain("migrated legacy dashboard profile");
    expect(fs.existsSync(legacyHome)).toBe(false);
    expect(fs.statSync(path.dirname(dashboardHome)).isDirectory()).toBe(true);
    expect(fs.statSync(dashboardHome).mode & 0o777).toBe(0o700);
    expect(fs.readFileSync(path.join(dashboardHome, "MEMORY.md"), "utf-8")).toBe("keep me\n");
    expect(readYaml(path.join(dashboardHome, "config.yaml")).model).toEqual({
      ...GATEWAY_CONFIG.model,
      provider: "nvidia-router",
    });
  });

  it("keeps seeding anchored when profiles is swapped after migration (#7200)", () => {
    const src = writeYaml("gw.yaml", GATEWAY_CONFIG);
    const hermesHome = path.join(tmpDir, ".hermes");
    const legacyHome = path.join(hermesHome, "dashboard-home");
    const profilesDir = path.join(hermesHome, "profiles");
    const heldProfiles = path.join(hermesHome, "profiles-before-swap");
    const outsideProfiles = path.join(tmpDir, "outside-profiles");
    const dashboardHome = path.join(profilesDir, "dashboard-home");
    fs.mkdirSync(legacyHome, { recursive: true });
    fs.mkdirSync(path.join(outsideProfiles, "dashboard-home"), { recursive: true });
    fs.writeFileSync(path.join(legacyHome, "MEMORY.md"), "keep me\n");

    const harness = `
import importlib.util
import os
import sys

spec = importlib.util.spec_from_file_location("seed_dashboard_config", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

ok, dashboard_fd = module._prepare_dashboard_destination(sys.argv[3])
if not ok or dashboard_fd is None:
    raise SystemExit(2)
try:
    os.rename(sys.argv[4], sys.argv[5])
    os.symlink(sys.argv[6], sys.argv[4])
    raise SystemExit(
        module._seed_dashboard(
            [sys.argv[1], sys.argv[7], sys.argv[2], sys.argv[3]], dashboard_fd
        )
    )
finally:
    os.close(dashboard_fd)
`;
    const res = spawnSync(
      "python3",
      [
        "-c",
        harness,
        SCRIPT_PATH,
        src,
        path.join(dashboardHome, "config.yaml"),
        profilesDir,
        heldProfiles,
        outsideProfiles,
        policyPath,
      ],
      {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 10_000,
      },
    );

    expect(res.status).toBe(0);
    expect(fs.lstatSync(profilesDir).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(outsideProfiles, "dashboard-home", "config.yaml"))).toBe(false);
    expect(readYaml(path.join(heldProfiles, "dashboard-home", "config.yaml")).model).toEqual({
      ...GATEWAY_CONFIG.model,
      provider: "nvidia-router",
    });
    expect(fs.readFileSync(path.join(heldProfiles, "dashboard-home", "MEMORY.md"), "utf-8")).toBe(
      "keep me\n",
    );
  });

  it("refuses to merge two populated dashboard profiles (#7200)", () => {
    const src = writeYaml("gw.yaml", GATEWAY_CONFIG);
    const hermesHome = path.join(tmpDir, ".hermes");
    const legacyHome = path.join(hermesHome, "dashboard-home");
    const dashboardHome = path.join(hermesHome, "profiles", "dashboard-home");
    fs.mkdirSync(legacyHome, { recursive: true });
    fs.mkdirSync(dashboardHome, { recursive: true });
    fs.writeFileSync(path.join(legacyHome, "MEMORY.md"), "legacy\n");
    fs.writeFileSync(path.join(dashboardHome, "MEMORY.md"), "current\n");

    const res = runSeed(src, path.join(dashboardHome, "config.yaml"));

    expect(res.status).toBe(1);
    expect(res.stderr).toContain("Refusing to merge legacy and current dashboard profiles");
    expect(fs.readFileSync(path.join(legacyHome, "MEMORY.md"), "utf-8")).toBe("legacy\n");
    expect(fs.readFileSync(path.join(dashboardHome, "MEMORY.md"), "utf-8")).toBe("current\n");
  });

  it("merges disjoint restored dashboard profile entries without clobbering (#7200)", () => {
    const src = writeYaml("gw.yaml", GATEWAY_CONFIG);
    const hermesHome = path.join(tmpDir, ".hermes");
    const legacyHome = path.join(hermesHome, "dashboard-home");
    const dashboardHome = path.join(hermesHome, "profiles", "dashboard-home");
    fs.mkdirSync(legacyHome, { recursive: true });
    fs.mkdirSync(dashboardHome, { recursive: true });
    fs.writeFileSync(path.join(legacyHome, "MEMORY.md"), "legacy memory\n");
    fs.writeFileSync(path.join(dashboardHome, "CURRENT.md"), "current memory\n");

    const res = runSeed(
      src,
      path.join(dashboardHome, "config.yaml"),
      undefined,
      undefined,
      {},
      true,
    );

    expect(res.status).toBe(0);
    expect(res.stderr).toContain("merged restored legacy dashboard profile");
    expect(fs.existsSync(legacyHome)).toBe(false);
    expect(fs.readFileSync(path.join(dashboardHome, "MEMORY.md"), "utf-8")).toBe("legacy memory\n");
    expect(fs.readFileSync(path.join(dashboardHome, "CURRENT.md"), "utf-8")).toBe(
      "current memory\n",
    );
  });

  it("refuses a colliding restored dashboard profile merge without clobbering (#7200)", () => {
    const src = writeYaml("gw.yaml", GATEWAY_CONFIG);
    const hermesHome = path.join(tmpDir, ".hermes");
    const legacyHome = path.join(hermesHome, "dashboard-home");
    const dashboardHome = path.join(hermesHome, "profiles", "dashboard-home");
    fs.mkdirSync(legacyHome, { recursive: true });
    fs.mkdirSync(dashboardHome, { recursive: true });
    fs.writeFileSync(path.join(legacyHome, "MEMORY.md"), "legacy\n");
    fs.writeFileSync(path.join(dashboardHome, "MEMORY.md"), "current\n");

    const res = runSeed(
      src,
      path.join(dashboardHome, "config.yaml"),
      undefined,
      undefined,
      {},
      true,
    );

    expect(res.status).toBe(1);
    expect(res.stderr).toContain("because an entry collides");
    expect(fs.readFileSync(path.join(legacyHome, "MEMORY.md"), "utf-8")).toBe("legacy\n");
    expect(fs.readFileSync(path.join(dashboardHome, "MEMORY.md"), "utf-8")).toBe("current\n");
  });

  it("fails closed if the empty destination changes before removal (#7200)", () => {
    const hermesHome = path.join(tmpDir, ".hermes");
    const legacyHome = path.join(hermesHome, "dashboard-home");
    const dashboardHome = path.join(hermesHome, "profiles", "dashboard-home");
    fs.mkdirSync(legacyHome, { recursive: true });
    fs.mkdirSync(dashboardHome, { recursive: true });
    fs.writeFileSync(path.join(legacyHome, "MEMORY.md"), "legacy\n");

    const harness = `
import errno
import importlib.util
import os
import sys

spec = importlib.util.spec_from_file_location("seed_dashboard_config", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

original_rmdir = module.os.rmdir
def fail_dashboard_removal(name, *args, **kwargs):
    if name == "dashboard-home":
        raise OSError(errno.ENOTEMPTY, "directory changed")
    return original_rmdir(name, *args, **kwargs)

module.os.rmdir = fail_dashboard_removal
ok, dashboard_fd = module._prepare_dashboard_destination(sys.argv[2])
if dashboard_fd is not None:
    os.close(dashboard_fd)
raise SystemExit(0 if not ok and dashboard_fd is None else 2)
`;
    const res = spawnSync(
      "python3",
      ["-c", harness, SCRIPT_PATH, path.join(dashboardHome, "config.yaml")],
      {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 10_000,
      },
    );

    expect(res.status).toBe(0);
    expect(res.stderr).toContain("changed unexpectedly");
    expect(res.stderr).not.toContain("Traceback");
    expect(fs.readFileSync(path.join(legacyHome, "MEMORY.md"), "utf-8")).toBe("legacy\n");
  });

  it("refuses to migrate a symlinked legacy dashboard profile (#7200)", () => {
    const src = writeYaml("gw.yaml", GATEWAY_CONFIG);
    const hermesHome = path.join(tmpDir, ".hermes");
    const legacyHome = path.join(hermesHome, "dashboard-home");
    const dashboardHome = path.join(hermesHome, "profiles", "dashboard-home");
    const outsideHome = path.join(tmpDir, "outside-dashboard-home");
    fs.mkdirSync(dashboardHome, { recursive: true });
    fs.mkdirSync(outsideHome);
    fs.writeFileSync(path.join(outsideHome, "MEMORY.md"), "outside\n");
    fs.symlinkSync(outsideHome, legacyHome);

    const res = runSeed(src, path.join(dashboardHome, "config.yaml"));

    expect(res.status).toBe(1);
    expect(res.stderr).toContain("is not a safe directory");
    expect(fs.lstatSync(legacyHome).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(outsideHome, "MEMORY.md"), "utf-8")).toBe("outside\n");
  });

  it("refuses to migrate through a symlinked profiles directory (#7200)", () => {
    const src = writeYaml("gw.yaml", GATEWAY_CONFIG);
    const hermesHome = path.join(tmpDir, ".hermes");
    const legacyHome = path.join(hermesHome, "dashboard-home");
    const profilesDir = path.join(hermesHome, "profiles");
    const outsideProfiles = path.join(tmpDir, "outside-profiles");
    fs.mkdirSync(legacyHome, { recursive: true });
    fs.mkdirSync(outsideProfiles);
    fs.writeFileSync(path.join(legacyHome, "MEMORY.md"), "legacy\n");
    fs.symlinkSync(outsideProfiles, profilesDir);

    const res = runSeed(src, path.join(profilesDir, "dashboard-home", "config.yaml"));

    expect(res.status).toBe(1);
    expect(res.stderr).toContain("is not a safe directory");
    expect(fs.existsSync(legacyHome)).toBe(true);
    expect(fs.readdirSync(outsideProfiles)).toEqual([]);
  });

  it("mirrors only the exact native Tavily backend into dashboard config", () => {
    const src = writeYaml("gw.yaml", {
      ...GATEWAY_CONFIG,
      web: { backend: "tavily", use_gateway: true, api_key: "do-not-copy" },
    });
    const dst = writeYaml("dash.yaml", { web: { max_results: 3 } });

    const res = runSeed(src, dst);

    expect(res.status).toBe(0);
    expect(readYaml(dst).web).toEqual({ max_results: 3, backend: "tavily" });
  });

  it("rejects Tavily policy drift without changing the dashboard config", () => {
    const src = writeYaml("gw.yaml", { ...GATEWAY_CONFIG, web: undefined });
    const dst = writeYaml("dash.yaml", { web: { max_results: 3, backend: "tavily" } });
    const before = fs.readFileSync(dst, "utf8");

    const result = runSeed(src, dst);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("gateway policy is invalid");
    expect(fs.readFileSync(dst, "utf8")).toBe(before);
  });

  it("rejects legacy routing that has no canonical provider key", () => {
    const legacy = {
      _config_version: 12,
      _nemoclaw_upstream: { provider: "NVIDIA Router", model: "nvidia-routed" },
      model: {
        default: "nvidia-routed",
        provider: "custom",
        base_url: "https://inference.local/v1",
        api_key: "sk-OPENSHELL-PROXY-REWRITE",
      },
      custom_providers: [
        {
          name: "NVIDIA Router",
          base_url: "https://inference.local/v1",
          api_key: "sk-OPENSHELL-PROXY-REWRITE",
          discover_models: true,
        },
      ],
      web: { backend: "tavily" },
      ...GATEWAY_POLICY,
    };
    const src = writeYaml("gw.yaml", legacy);
    const dst = path.join(tmpDir, "dash.yaml");

    const res = runSeed(src, dst);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("invalid model routing");
    expect(fs.existsSync(dst)).toBe(false);
  });

  it.each(
    Array.from(
      [
        [
          "model",
          (gateway) => {
            gateway.model.api_key = "sk-raw-model-credential";
          },
        ],
        [
          "provider",
          (gateway) => {
            gateway.providers["nvidia-router"].api_key = "sk-raw-provider-credential";
          },
        ],
        [
          "custom provider",
          (gateway) => {
            gateway.custom_providers[0].api_key = "sk-raw-custom-provider-credential";
          },
        ],
      ] as Array<[string, (gateway: typeof GATEWAY_CONFIG) => void]>,
      (value) => [value],
    ),
  )(
    "rejects raw credentials in every mirrored routing shape [case %#] (#8008)",
    ([location, injectRawCredential]) => {
      const gateway = structuredClone(GATEWAY_CONFIG);
      injectRawCredential(gateway);
      const src = writeYaml(`gw-${location}.yaml`, gateway);
      const dst = writeYaml(`dash-${location}.yaml`, { dashboard_local: true });
      const before = fs.readFileSync(dst, "utf8");

      const result = runSeed(src, dst);

      expect(result.status, location).toBe(1);
      expect(result.stderr, location).toContain("[SECURITY]");
      expect(result.stderr, location).not.toContain("sk-raw-");
      expect(fs.readFileSync(dst, "utf8"), location).toBe(before);
    },
  );

  it("mirrors only dashboard-needed gateway .env keys for Hermes 0.16 chat setup", () => {
    const src = writeYaml("gw.yaml", GATEWAY_CONFIG);
    const dst = path.join(tmpDir, "dash.yaml");
    const envSrc = path.join(tmpDir, "gw.env");
    const envDst = path.join(tmpDir, "dash.env");
    fs.writeFileSync(
      envSrc,
      [
        "API_SERVER_HOST=127.0.0.1",
        "API_SERVER_PORT=18642",
        `API_SERVER_KEY=${GENERATED_HEX_TOKEN}`,
        `TAVILY_API_KEY=${TAVILY_API_KEY_PLACEHOLDER}`,
        "FIRECRAWL_GATEWAY_URL=http://host.openshell.internal:11436/firecrawl",
        "NEMOCLAW_HERMES_TOOL_GATEWAY_BROKER=1",
        "MODAL_GATEWAY_URL=http://host.openshell.internal:11436/modal",
        "OPENAI_API_KEY=do-not-copy",
        "TELEGRAM_BOT_TOKEN=openshell:resolve:env:TELEGRAM_BOT_TOKEN",
        "TERMINAL_CWD=/sandbox",
        "",
      ].join("\n"),
    );

    const res = runSeed(src, dst, envSrc, envDst);
    expect(res.status).toBe(0);

    expect(fs.readFileSync(envDst, "utf-8")).toBe(
      [
        "API_SERVER_HOST=127.0.0.1",
        "API_SERVER_PORT=18642",
        `TAVILY_API_KEY=${TAVILY_API_KEY_PLACEHOLDER}`,
        "FIRECRAWL_GATEWAY_URL=http://host.openshell.internal:11436/firecrawl",
        "NEMOCLAW_HERMES_TOOL_GATEWAY_BROKER=1",
        "MODAL_GATEWAY_URL=http://host.openshell.internal:11436/modal",
        "",
      ].join("\n"),
    );
    expect(fs.statSync(envDst).mode & 0o777).toBe(0o600);
  });

  it("keeps API_SERVER_KEY out of the dashboard .env mirror", () => {
    const src = writeYaml("gw.yaml", GATEWAY_CONFIG);
    const dst = path.join(tmpDir, "dash.yaml");
    const envSrc = path.join(tmpDir, "gw.env");
    const envDst = path.join(tmpDir, "dash.env");
    fs.writeFileSync(
      envSrc,
      [
        `export API_SERVER_KEY=${GENERATED_HEX_TOKEN}`,
        "export OPENAI_API_KEY=do-not-copy",
        "API_SERVER_HOST=127.0.0.1",
        "",
      ].join("\n"),
    );

    const res = runSeed(src, dst, envSrc, envDst);
    expect(res.status).toBe(0);

    expect(fs.readFileSync(envDst, "utf-8")).toBe("API_SERVER_HOST=127.0.0.1\n");
  });

  it.each(
    Array.from(
      [
        "API_SERVER_KEY=server-key",
        "API_SERVER_KEY='server-key'",
        'export API_SERVER_KEY="server-key"',
      ].entries(),
      (value) => [value],
    ),
  )(
    "ignores API_SERVER_KEY values instead of parsing or mirroring them [%s]",
    ([index, weakLine]) => {
      const src = writeYaml(`gw-${index}.yaml`, GATEWAY_CONFIG);
      const dst = path.join(tmpDir, `dash-${index}.yaml`);
      const envSrc = path.join(tmpDir, `gw-${index}.env`);
      const envDst = path.join(tmpDir, `dash-${index}.env`);
      fs.writeFileSync(envSrc, `${weakLine}\nAPI_SERVER_HOST=127.0.0.1\n`);

      const res = runSeed(src, dst, envSrc, envDst);

      expect(res.status, weakLine).toBe(0);
      expect(res.stderr, weakLine).not.toContain("server-key");
      expect(fs.readFileSync(envDst, "utf-8"), weakLine).toBe("API_SERVER_HOST=127.0.0.1\n");
    },
  );

  it("rejects a literal Tavily key instead of mirroring it into the dashboard .env", () => {
    const src = writeYaml("gw.yaml", GATEWAY_CONFIG);
    const dst = path.join(tmpDir, "dash.yaml");
    const envSrc = path.join(tmpDir, "gw.env");
    const envDst = path.join(tmpDir, "dash.env");
    fs.writeFileSync(envSrc, "TAVILY_API_KEY=tvly-test-literal\nAPI_SERVER_HOST=127.0.0.1\n");

    const res = runSeed(src, dst, envSrc, envDst);

    expect(res.status).toBe(1);
    expect(res.stderr).toContain("TAVILY_API_KEY");
    expect(res.stderr).not.toContain("tvly-test-literal");
    expect(fs.existsSync(envDst)).toBe(false);
  });

  it.each([{ scenario: "dashboard config" }, { scenario: "dashboard environment" }])(
    "applies requested dashboard seed owner and mode before the atomic rename [$scenario]",
    ({ scenario }) => {
      const uid = process.getuid?.() ?? Number.NaN;
      const gid = process.getgid?.() ?? Number.NaN;
      const src = writeYaml("gw.yaml", GATEWAY_CONFIG);
      const dst = path.join(tmpDir, "dash.yaml");
      const envSrc = path.join(tmpDir, "gw.env");
      const envDst = path.join(tmpDir, "dash.env");
      fs.writeFileSync(envSrc, `API_SERVER_KEY=${GENERATED_HEX_TOKEN}\n`);

      const res = runSeed(src, dst, envSrc, envDst, {
        NEMOCLAW_DASHBOARD_SEED_OWNER: `${uid}:${gid}`,
      });

      expect(res.status).toBe(0);
      expect(Number.isInteger(uid)).toBe(true);
      expect(Number.isInteger(gid)).toBe(true);
      const seededPath = ({ "dashboard config": dst, "dashboard environment": envDst } as const)[
        scenario
      ]!;
      const stat = fs.statSync(seededPath);
      expect(stat.uid).toBe(uid);
      expect(stat.gid).toBe(gid);
      expect(stat.mode & 0o777).toBe(0o600);
    },
  );

  it("keeps custom_providers dynamic via discover_models (no static model list)", () => {
    const src = writeYaml("gw.yaml", GATEWAY_CONFIG);
    const dst = path.join(tmpDir, "dash.yaml");

    runSeed(src, dst);

    const dash = readYaml(dst) as {
      custom_providers: Array<Record<string, unknown>>;
    };
    expect(dash.custom_providers[0].discover_models).toBe(true);
    // No hard-coded models: list — the dashboard live-lists /v1/models.
    expect(dash.custom_providers[0]).not.toHaveProperty("models");
  });

  it("does NOT mirror platforms/plugins (avoids the gateway port conflict)", () => {
    const src = writeYaml("gw.yaml", GATEWAY_CONFIG);
    const dst = path.join(tmpDir, "dash.yaml");

    runSeed(src, dst);

    expect(readYaml(dst)).not.toHaveProperty("platforms");
  });

  it("merges policy leaves while preserving dashboard-owned sibling settings", () => {
    const src = writeYaml("gw.yaml", GATEWAY_CONFIG);
    // Mirrors what `hermes dashboard` writes on first launch: empty model,
    // empty providers, plus a higher config version and a dashboard-local pref.
    const dst = writeYaml("dash.yaml", {
      _config_version: 27,
      model: "",
      providers: {},
      approvals: { mode: "off", dashboard_note: "keep" },
      browser: { restrict_evaluate: false, headed: true },
      session_reset: {
        mode: "none",
        at_hour: 0,
        idle_minutes: 1,
        notify: false,
        notify_exclude_platforms: ["discord"],
        bg_process_max_age_hours: 1,
        dashboard_scope: "keep",
      },
      display: {
        compact: true,
        show_reasoning: true,
        show_commentary: true,
      },
      updates: {
        pre_update_backup: "quick",
        refresh_cua_driver: true,
        channel: "stable",
      },
    });

    const res = runSeed(src, dst);
    expect(res.status).toBe(0);

    const dash = readYaml(dst);
    // Routing overwritten...
    expect(dash.model).toEqual({ ...GATEWAY_CONFIG.model, provider: "nvidia-router" });
    expect(dash.providers).toEqual(GATEWAY_CONFIG.providers);
    expect(dash.custom_providers).toEqual(GATEWAY_CONFIG.custom_providers);
    // ...dashboard-local keys preserved.
    expect(dash._config_version).toBe(27);
    expect(dash.approvals).toEqual({
      mode: "manual",
      dashboard_note: "keep",
    });
    expect(dash.browser).toEqual({
      allow_unsafe_evaluate: false,
      restrict_evaluate: true,
      headed: true,
    });
    expect(dash.session_reset).toEqual({
      ...EXPECTED_DASHBOARD_POLICY.session_reset,
      dashboard_scope: "keep",
    });
    expect(dash.display).toEqual({
      compact: true,
      show_reasoning: false,
      show_commentary: false,
    });
    expect(dash.updates).toEqual({
      pre_update_backup: false,
      refresh_cua_driver: false,
      channel: "stable",
    });
  });

  it.each([
    ["missing approvals", { approvals: undefined }],
    ["wrong browser boolean", { browser: { restrict_evaluate: "true" } }],
    ["incomplete session policy", { session_reset: { mode: "both" } }],
    [
      "unexpected session policy field",
      {
        session_reset: {
          ...EXPECTED_DASHBOARD_POLICY.session_reset,
          dashboard_only: true,
        },
      },
    ],
    ["wrong display boolean", { display: { show_reasoning: "false", show_commentary: false } }],
    ["wrong update mode", { updates: { pre_update_backup: 0, refresh_cua_driver: false } }],
  ])("fails closed on %s", (_label, override) => {
    const src = writeYaml("gw.yaml", {
      ...GATEWAY_CONFIG,
      ...override,
    });
    const dst = writeYaml("dash.yaml", {
      display: { compact: true },
    });
    const before = fs.readFileSync(dst, "utf-8");

    const res = runSeed(src, dst);

    expect(res.status).toBe(1);
    expect(res.stderr).toContain("[SECURITY]");
    expect(res.stderr).toContain("gateway policy is invalid");
    expect(fs.readFileSync(dst, "utf-8")).toBe(before);
  });

  it("is idempotent across repeated launches", () => {
    const src = writeYaml("gw.yaml", GATEWAY_CONFIG);
    const dst = path.join(tmpDir, "dash.yaml");

    runSeed(src, dst);
    const first = fs.readFileSync(dst, "utf-8");
    runSeed(src, dst);
    const second = fs.readFileSync(dst, "utf-8");

    expect(second).toBe(first);
  });

  it("is a benign no-op when the gateway config is missing", () => {
    const dst = path.join(tmpDir, "dash.yaml");
    const res = runSeed(path.join(tmpDir, "absent.yaml"), dst);

    expect(res.status).toBe(0);
    expect(fs.existsSync(dst)).toBe(false);
  });

  it("still mirrors .env when the gateway config is missing", () => {
    const dst = path.join(tmpDir, "dash.yaml");
    const envSrc = path.join(tmpDir, "gw.env");
    const envDst = path.join(tmpDir, "dash.env");
    fs.writeFileSync(envSrc, `API_SERVER_KEY=${GENERATED_HEX_TOKEN}\n`);

    const res = runSeed(path.join(tmpDir, "absent.yaml"), dst, envSrc, envDst);

    expect(res.status).toBe(0);
    expect(fs.existsSync(dst)).toBe(false);
    expect(fs.readFileSync(envDst, "utf-8")).toBe("");
  });

  it("fails closed without changing stale dashboard config when gateway routing is absent", () => {
    const src = writeYaml("gw.yaml", {
      _config_version: 12,
      terminal: { backend: "local" },
    });
    const dst = writeYaml("dash.yaml", {
      model: { default: "stale-model" },
      approvals: { mode: "off" },
    });
    const before = fs.readFileSync(dst, "utf-8");

    const res = runSeed(src, dst);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("[SECURITY]");
    expect(res.stderr).toContain("invalid model routing");
    expect(fs.readFileSync(dst, "utf-8")).toBe(before);
  });

  it("does not expose malformed gateway YAML or replace stale dashboard config", () => {
    const secret = "sk-secret-NEMOCLAW-PARSER-LEAK";
    const src = path.join(tmpDir, "gw.yaml");
    const dst = writeYaml("dash.yaml", {
      model: { default: "stale-model" },
      approvals: { mode: "off" },
    });
    const envSrc = path.join(tmpDir, "gw.env");
    const envDst = path.join(tmpDir, "dash.env");
    const before = fs.readFileSync(dst, "utf-8");
    fs.writeFileSync(envSrc, `API_SERVER_KEY=${GENERATED_HEX_TOKEN}\n`);
    fs.writeFileSync(envDst, "API_SERVER_HOST=stale.invalid\n");
    const envBefore = fs.readFileSync(envDst, "utf-8");
    fs.writeFileSync(src, `model:\n  api_key: [${secret}\n`);

    const res = runSeed(src, dst, envSrc, envDst);

    expect(res.status).toBe(1);
    expect(res.stderr).toContain("[SECURITY]");
    expect(res.stderr).toContain("gateway config is invalid or unreadable");
    expect(res.stderr).not.toContain(secret);
    expect(fs.readFileSync(dst, "utf-8")).toBe(before);
    expect(fs.readFileSync(envDst, "utf-8")).toBe(envBefore);
  });

  it("rejects a non-mapping gateway document without replacing stale dashboard config", () => {
    const src = writeYaml("gw.yaml", ["not", "a", "mapping"]);
    const dst = writeYaml("dash.yaml", {
      model: { default: "stale-model" },
      approvals: { mode: "off" },
    });
    const before = fs.readFileSync(dst, "utf-8");

    const res = runSeed(src, dst);

    expect(res.status).toBe(1);
    expect(res.stderr).toContain("[SECURITY]");
    expect(res.stderr).toContain("gateway config is invalid or unreadable");
    expect(fs.readFileSync(dst, "utf-8")).toBe(before);
  });

  it("does not expose or recreate malformed existing dashboard YAML", () => {
    const secret = "sk-secret-NEMOCLAW-DASHBOARD-LEAK";
    const src = writeYaml("gw.yaml", GATEWAY_CONFIG);
    const dst = path.join(tmpDir, "dash.yaml");
    fs.writeFileSync(dst, `model:\n  api_key: [${secret}\n`);
    const before = fs.readFileSync(dst, "utf-8");

    const res = runSeed(src, dst);

    expect(res.status).toBe(1);
    expect(res.stderr).toContain("[SECURITY]");
    expect(res.stderr).toContain("existing dashboard config is invalid or unreadable");
    expect(res.stderr).not.toContain(secret);
    expect(fs.readFileSync(dst, "utf-8")).toBe(before);
  });

  it("refuses to follow a symlink at the dashboard config path", () => {
    const src = writeYaml("gw.yaml", GATEWAY_CONFIG);
    const realTarget = writeYaml("real-target.yaml", {
      secret: "do-not-touch",
    });
    const dst = path.join(tmpDir, "dash.yaml");
    fs.symlinkSync(realTarget, dst);

    const res = runSeed(src, dst);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("[SECURITY]");
    // The symlink target must be untouched.
    expect(readYaml(realTarget)).toEqual({ secret: "do-not-touch" });
  });

  it("refuses to read a symlinked gateway config source", () => {
    const realTarget = writeYaml("real-target.yaml", {
      model: {
        default: "secret-model",
        provider: "secret-provider",
        base_url: "https://secret.invalid/v1",
      },
    });
    const src = path.join(tmpDir, "gw.yaml");
    const dst = path.join(tmpDir, "dash.yaml");
    fs.symlinkSync(realTarget, src);

    const res = runSeed(src, dst);

    expect(res.status).toBe(1);
    expect(res.stderr).toContain("[SECURITY]");
    expect(fs.existsSync(dst)).toBe(false);
  });

  it("refuses a pre-existing temp symlink when writing the dashboard config", () => {
    const src = writeYaml("gw.yaml", GATEWAY_CONFIG);
    const dst = path.join(tmpDir, "dash.yaml");
    const realTarget = writeYaml("real-target.yaml", {
      secret: "do-not-touch",
    });
    fs.symlinkSync(realTarget, `${dst}.nemoclaw.tmp`);

    const res = runSeed(src, dst);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("[SECURITY]");
    expect(fs.existsSync(dst)).toBe(false);
    expect(readYaml(realTarget)).toEqual({ secret: "do-not-touch" });
  });

  it("refuses to follow a symlink at the dashboard env path", () => {
    const src = writeYaml("gw.yaml", GATEWAY_CONFIG);
    const dst = path.join(tmpDir, "dash.yaml");
    const envSrc = path.join(tmpDir, "gw.env");
    const realTarget = path.join(tmpDir, "real-target.env");
    const envDst = path.join(tmpDir, "dash.env");
    fs.writeFileSync(envSrc, `API_SERVER_KEY=${GENERATED_HEX_TOKEN}\n`);
    fs.writeFileSync(realTarget, "SECRET=do-not-touch\n");
    fs.symlinkSync(realTarget, envDst);

    const res = runSeed(src, dst, envSrc, envDst);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("[SECURITY]");
    expect(fs.readFileSync(realTarget, "utf-8")).toBe("SECRET=do-not-touch\n");
  });

  it("refuses to read a symlinked gateway env source", () => {
    const src = writeYaml("gw.yaml", GATEWAY_CONFIG);
    const dst = path.join(tmpDir, "dash.yaml");
    const realTarget = path.join(tmpDir, "real-target.env");
    const envSrc = path.join(tmpDir, "gw.env");
    const envDst = path.join(tmpDir, "dash.env");
    fs.writeFileSync(realTarget, "API_SERVER_KEY=do-not-copy\n");
    fs.symlinkSync(realTarget, envSrc);

    const res = runSeed(src, dst, envSrc, envDst);

    expect(res.status).toBe(1);
    expect(res.stderr).toContain("[SECURITY]");
    expect(fs.existsSync(envDst)).toBe(false);
    expect(fs.readFileSync(realTarget, "utf-8")).toBe("API_SERVER_KEY=do-not-copy\n");
  });

  it("refuses a pre-existing temp symlink when writing the dashboard env", () => {
    const src = writeYaml("gw.yaml", GATEWAY_CONFIG);
    const dst = path.join(tmpDir, "dash.yaml");
    const envSrc = path.join(tmpDir, "gw.env");
    const envDst = path.join(tmpDir, "dash.env");
    const realTarget = path.join(tmpDir, "real-target.env");
    fs.writeFileSync(envSrc, `API_SERVER_KEY=${GENERATED_HEX_TOKEN}\n`);
    fs.writeFileSync(realTarget, "SECRET=do-not-touch\n");
    fs.symlinkSync(realTarget, `${envDst}.nemoclaw.tmp`);

    const res = runSeed(src, dst, envSrc, envDst);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("[SECURITY]");
    expect(fs.readFileSync(realTarget, "utf-8")).toBe("SECRET=do-not-touch\n");
  });
});

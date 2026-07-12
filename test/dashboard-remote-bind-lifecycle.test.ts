// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hasPreparedRemoteDashboardBind,
  patchStagedDockerfile as patchStagedDockerfileImpl,
} from "../src/lib/onboard/dockerfile-patch";
import { prepareSandboxCreateLaunch } from "../src/lib/onboard/sandbox-create-launch";
import { prepareSandboxDockerfilePatch } from "../src/lib/onboard/sandbox-dockerfile-patch-flow";
import { buildCreatedSandboxRegistryEntry } from "../src/lib/onboard/sandbox-registration";
import { applyReusedSandboxDashboardState } from "../src/lib/onboard/sandbox-reuse";

const requireSource = createRequire(import.meta.url);
const { ensureSandboxPortForward } = requireSource(
  "../src/lib/actions/sandbox/forward-recovery.js",
) as typeof import("../src/lib/actions/sandbox/forward-recovery.js");

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function remoteBindDockerfile(...postGeneratorInstructions: string[]): string {
  return [
    "FROM scratch",
    "ARG NEMOCLAW_MODEL=",
    "ARG CHAT_UI_URL=",
    "ARG NEMOCLAW_DASHBOARD_BIND=",
    "ENV NEMOCLAW_DASHBOARD_BIND=${NEMOCLAW_DASHBOARD_BIND}",
    "RUN node --experimental-strip-types /scripts/generate-openclaw-config.mts",
    ...postGeneratorInstructions,
  ].join("\n");
}

const MANAGED_PROXY_PATCH = `RUN python3 -c " import json, os; path = os.path.expanduser('~/.openclaw/openclaw.json'); cfg = json.load(open(path)); cfg.setdefault('gateway', {}).setdefault('auth', {})['token'] = ''; proxy_host = os.environ.get('NEMOCLAW_PROXY_HOST') or '10.200.0.1'; proxy_port = os.environ.get('NEMOCLAW_PROXY_PORT') or '3128'; cfg['proxy'] = { 'enabled': True, 'proxyUrl': f'http://{proxy_host}:{proxy_port}', 'loopbackMode': 'gateway-only', }; json.dump(cfg, open(path, 'w'), indent=2); os.chmod(path, 0o600)"`;

function patchStagedDockerfile(
  dockerfilePath: string,
  model: string,
  chatUiUrl: string,
): ReturnType<typeof patchStagedDockerfileImpl> {
  return patchStagedDockerfileImpl(
    dockerfilePath,
    model,
    chatUiUrl,
    undefined,
    null,
    null,
    null,
    null,
    false,
    null,
    [],
    { trustedManagedDockerfile: true },
  );
}

describe("remote dashboard bind production lifecycle", () => {
  it.each([
    [
      "pre-generator NODE_OPTIONS",
      "ENV NODE_OPTIONS=--require=/tmp/bypass.cjs",
      "before-generator",
    ],
    ["pre-generator PATH", "ENV PATH=/tmp/bypass:${PATH}", "before-generator"],
    ["pre-generator SHELL", 'SHELL ["/tmp/bypass-shell", "-c"]', "before-generator"],
    ["post-generator PATH", "ENV PATH=/tmp/bypass:${PATH}", "before-config-hash"],
    ["post-generator PYTHONPATH", "ENV PYTHONPATH=/tmp/bypass", "before-proxy-patch"],
    ["replacement HEALTHCHECK", "HEALTHCHECK CMD /tmp/bypass-healthcheck", "append"],
    ["replacement ENTRYPOINT", 'ENTRYPOINT ["/tmp/bypass-entrypoint"]', "append"],
    ["replacement CMD", 'CMD ["/tmp/bypass-command"]', "append"],
  ])("rejects custom --from remote bind with %s (#6024)", async (_label, instruction, location) => {
    vi.stubEnv("NEMOCLAW_DASHBOARD_BIND", "0.0.0.0");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-remote-bind-from-"));
    const dockerfile = path.join(directory, "Dockerfile");
    const stockDockerfile = fs.readFileSync(path.join(process.cwd(), "Dockerfile"), "utf8");
    const generator =
      "RUN NEMOCLAW_OPENCLAW_MANAGED_PROXY=0 node --experimental-strip-types /scripts/generate-openclaw-config.mts";
    const proxyPatch = 'RUN python3 -c "\\\n';
    const configHash =
      "RUN sha256sum /sandbox/.openclaw/openclaw.json > /sandbox/.openclaw/.config-hash";
    const body =
      location === "before-generator"
        ? stockDockerfile.replace(generator, `${instruction}\n${generator}`)
        : location === "before-proxy-patch"
          ? stockDockerfile.replace(proxyPatch, `${instruction}\n${proxyPatch}`)
          : location === "before-config-hash"
            ? stockDockerfile.replace(configHash, `${instruction}\n${configHash}`)
            : `${stockDockerfile}\n${instruction}\n`;
    fs.writeFileSync(dockerfile, body);

    try {
      await expect(
        prepareSandboxDockerfilePatch({
          agent: { name: "openclaw" } as never,
          fromDockerfile: dockerfile,
          sandboxBaseImage: "ghcr.io/nvidia/nemoclaw/sandbox-base",
          sandboxBaseTag: "latest",
          stagedDockerfile: dockerfile,
          model: "test-model",
          chatUiUrl: "http://127.0.0.1:18789",
          provider: null,
          preferredInferenceApi: null,
          webSearchConfig: null,
          hermesToolGateways: [],
          sandboxGpuConfig: { mode: "0" } as never,
          log: vi.fn(),
          deps: {
            isLinuxDockerDriverGatewayEnabled: () => false,
            pullAndResolveBaseImageDigest: () => ({
              digest: "sha256:custom",
              ref: "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:custom",
            }),
            enforceDockerGpuPatchPreserveNetwork: async () => false,
            now: () => 1,
          },
        }),
      ).rejects.toThrow(/custom --from Dockerfiles.*runtime configuration attestation/);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("prepares remote bind from the exact checked-in Dockerfile instructions (#6024)", () => {
    vi.stubEnv("NEMOCLAW_DASHBOARD_BIND", "0.0.0.0");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-remote-bind-stock-"));
    const dockerfile = path.join(directory, "Dockerfile");
    fs.copyFileSync(path.join(process.cwd(), "Dockerfile"), dockerfile);

    try {
      const result = patchStagedDockerfile(dockerfile, "test-model", "http://127.0.0.1:18789");
      expect(result.dashboardRemoteBindPrepared).toBe(true);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("carries the audited remote-exposure signal through image and sandbox creation (#6024)", () => {
    vi.stubEnv("NEMOCLAW_DASHBOARD_BIND", "0.0.0.0");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-remote-bind-"));
    const dockerfile = path.join(directory, "Dockerfile");
    fs.writeFileSync(
      dockerfile,
      [
        "ARG CHAT_UI_URL=http://127.0.0.1:18789",
        "ARG NEMOCLAW_DASHBOARD_BIND=",
        "ARG NEMOCLAW_DISABLE_DEVICE_AUTH=0",
        "ENV NEMOCLAW_DASHBOARD_BIND=${NEMOCLAW_DASHBOARD_BIND}",
        "RUN node --experimental-strip-types /scripts/generate-openclaw-config.mts",
      ].join("\n"),
    );

    try {
      patchStagedDockerfile(dockerfile, "test-model", "http://127.0.0.1:18789");
      expect(fs.readFileSync(dockerfile, "utf8")).toContain("ARG NEMOCLAW_DASHBOARD_BIND=0.0.0.0");

      const launch = prepareSandboxCreateLaunch({
        agent: { name: "openclaw" } as never,
        chatUiUrl: "http://127.0.0.1:18789",
        createArgs: [],
        env: { NEMOCLAW_DASHBOARD_BIND: "0.0.0.0" },
        extraPlaceholderKeys: [],
        getDashboardForwardPort: () => "18789",
        hermesDashboardState: { enabled: false, config: null },
        openshellShellCommand: (args) => args.join(" "),
        buildEnv: () => ({}),
      });
      expect(launch.envArgs).toContain("NEMOCLAW_DASHBOARD_BIND=0.0.0.0");

      const entry = buildCreatedSandboxRegistryEntry({
        sandboxName: "beta",
        inferenceSelection: {
          model: "test-model",
          provider: "nvidia",
          endpointUrl: null,
          credentialEnv: null,
          preferredInferenceApi: null,
          compatibleEndpointReasoning: null,
          nimContainer: null,
        },
        runtimeFields: {
          gpuEnabled: false,
          hostGpuDetected: false,
          sandboxGpuEnabled: false,
          sandboxGpuMode: "0",
          sandboxGpuDevice: null,
          sandboxGpuProof: null,
          openshellDriver: "docker",
          openshellVersion: "0.1.2",
        },
        agent: { name: "openclaw" } as never,
        agentVersionKnown: true,
        imageTag: null,
        appliedPolicies: [],
        plannedMessagingState: undefined,
        hermesToolGateways: [],
        hermesDashboardState: { enabled: false, config: null },
        dashboardPort: 18789,
        dashboardRemoteBindPrepared: hasPreparedRemoteDashboardBind(dockerfile),
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
      });
      expect(entry.dashboardRemoteBindPrepared).toBe(true);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses remote preparation when a custom Dockerfile lacks the bind contract (#6024)", () => {
    vi.stubEnv("NEMOCLAW_DASHBOARD_BIND", "0.0.0.0");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-remote-bind-custom-"));
    const dockerfile = path.join(directory, "Dockerfile");
    fs.writeFileSync(
      dockerfile,
      ["ARG NEMOCLAW_MODEL=", "ARG CHAT_UI_URL=", "FROM scratch"].join("\n"),
    );

    try {
      expect(() =>
        patchStagedDockerfile(dockerfile, "test-model", "http://127.0.0.1:18789"),
      ).toThrow(/missing ARG NEMOCLAW_DASHBOARD_BIND/);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses remote preparation when a custom Dockerfile declares but never consumes the bind arg (#6024)", () => {
    vi.stubEnv("NEMOCLAW_DASHBOARD_BIND", "0.0.0.0");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-remote-bind-unused-"));
    const dockerfile = path.join(directory, "Dockerfile");
    fs.writeFileSync(
      dockerfile,
      [
        "FROM scratch",
        "ARG NEMOCLAW_MODEL=",
        "ARG CHAT_UI_URL=",
        "ARG NEMOCLAW_DASHBOARD_BIND=",
      ].join("\n"),
    );

    try {
      expect(() =>
        patchStagedDockerfile(dockerfile, "test-model", "http://127.0.0.1:18789"),
      ).toThrow(/does not promote it to generate-openclaw-config/);
      expect(hasPreparedRemoteDashboardBind(dockerfile)).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects remote-bind proof that only appears in an unused build stage (#6024)", () => {
    vi.stubEnv("NEMOCLAW_DASHBOARD_BIND", "0.0.0.0");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-remote-bind-decoy-"));
    const dockerfile = path.join(directory, "Dockerfile");
    fs.writeFileSync(
      dockerfile,
      [
        "FROM scratch AS decoy",
        "ARG NEMOCLAW_DASHBOARD_BIND=",
        "ENV NEMOCLAW_DASHBOARD_BIND=${NEMOCLAW_DASHBOARD_BIND}",
        "RUN node --experimental-strip-types /scripts/generate-openclaw-config.mts",
        "FROM scratch",
        "ARG NEMOCLAW_MODEL=",
        "ARG CHAT_UI_URL=",
        "ARG NEMOCLAW_DASHBOARD_BIND=",
      ].join("\n"),
    );

    try {
      expect(() =>
        patchStagedDockerfile(dockerfile, "test-model", "http://127.0.0.1:18789"),
      ).toThrow(/does not promote it to generate-openclaw-config/);
      expect(hasPreparedRemoteDashboardBind(dockerfile)).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects final-stage config overwrites after the remote-bind generator (#6024)", () => {
    vi.stubEnv("NEMOCLAW_DASHBOARD_BIND", "0.0.0.0");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-remote-bind-overwrite-"));
    const dockerfile = path.join(directory, "Dockerfile");
    fs.writeFileSync(
      dockerfile,
      [
        "FROM scratch",
        "ARG NEMOCLAW_MODEL=",
        "ARG CHAT_UI_URL=",
        "ARG NEMOCLAW_DASHBOARD_BIND=",
        "ENV NEMOCLAW_DASHBOARD_BIND=${NEMOCLAW_DASHBOARD_BIND}",
        "RUN node --experimental-strip-types /scripts/generate-openclaw-config.mts",
        "RUN printf '{}' > /sandbox/.openclaw/openclaw.json",
      ].join("\n"),
    );

    try {
      expect(() =>
        patchStagedDockerfile(dockerfile, "test-model", "http://127.0.0.1:18789"),
      ).toThrow(/preserve the generated remote dashboard output/);
      expect(hasPreparedRemoteDashboardBind(dockerfile)).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    [
      "generator",
      remoteBindDockerfile().replace(
        "RUN node --experimental-strip-types /scripts/generate-openclaw-config.mts",
        "RUN node --experimental-strip-types /scripts/generate-openclaw-config.mts && printf '{}' > /sandbox/.openclaw/openclaw.json",
      ),
    ],
    [
      "allowlisted command",
      remoteBindDockerfile(
        "RUN chmod 660 /sandbox/.openclaw/openclaw.json && printf '{}' > /sandbox/.openclaw/openclaw.json",
      ),
    ],
  ])("rejects a compound %s instruction that appends a config rewrite (#6024)", (_label, body) => {
    vi.stubEnv("NEMOCLAW_DASHBOARD_BIND", "0.0.0.0");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-remote-bind-compound-"));
    const dockerfile = path.join(directory, "Dockerfile");
    fs.writeFileSync(dockerfile, body);

    try {
      expect(() =>
        patchStagedDockerfile(dockerfile, "test-model", "http://127.0.0.1:18789"),
      ).toThrow(/generate-openclaw-config|preserve the generated remote dashboard output/);
      expect(hasPreparedRemoteDashboardBind(dockerfile)).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects Node rewrites after the remote-bind generator (#6024)", () => {
    vi.stubEnv("NEMOCLAW_DASHBOARD_BIND", "0.0.0.0");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-remote-bind-node-"));
    const dockerfile = path.join(directory, "Dockerfile");
    fs.writeFileSync(
      dockerfile,
      remoteBindDockerfile(
        `RUN node -e "require('node:fs').writeFileSync('/sandbox/.openclaw/openclaw.json','{}')"`,
      ),
    );

    try {
      expect(() =>
        patchStagedDockerfile(dockerfile, "test-model", "http://127.0.0.1:18789"),
      ).toThrow(/preserve the generated remote dashboard output/);
      expect(hasPreparedRemoteDashboardBind(dockerfile)).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects Python rewrites after the remote-bind generator (#6024)", () => {
    vi.stubEnv("NEMOCLAW_DASHBOARD_BIND", "0.0.0.0");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-remote-bind-python-"));
    const dockerfile = path.join(directory, "Dockerfile");
    fs.writeFileSync(
      dockerfile,
      remoteBindDockerfile(
        `RUN python3 -c "import json; json.dump({}, open('/sandbox/.openclaw/openclaw.json','w'))"`,
      ),
    );

    try {
      expect(() =>
        patchStagedDockerfile(dockerfile, "test-model", "http://127.0.0.1:18789"),
      ).toThrow(/preserve the generated remote dashboard output/);
      expect(hasPreparedRemoteDashboardBind(dockerfile)).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects tee rewrites after the remote-bind generator (#6024)", () => {
    vi.stubEnv("NEMOCLAW_DASHBOARD_BIND", "0.0.0.0");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-remote-bind-tee-"));
    const dockerfile = path.join(directory, "Dockerfile");
    fs.writeFileSync(
      dockerfile,
      remoteBindDockerfile("RUN printf '{}' | tee /sandbox/.openclaw/openclaw.json >/dev/null"),
    );

    try {
      expect(() =>
        patchStagedDockerfile(dockerfile, "test-model", "http://127.0.0.1:18789"),
      ).toThrow(/preserve the generated remote dashboard output/);
      expect(hasPreparedRemoteDashboardBind(dockerfile)).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("allows final-stage config metadata updates after the remote-bind generator (#6024)", () => {
    vi.stubEnv("NEMOCLAW_DASHBOARD_BIND", "0.0.0.0");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-remote-bind-metadata-"));
    const dockerfile = path.join(directory, "Dockerfile");
    fs.writeFileSync(
      dockerfile,
      [
        "FROM scratch",
        "ARG NEMOCLAW_MODEL=",
        "ARG CHAT_UI_URL=",
        "ARG NEMOCLAW_DASHBOARD_BIND=",
        "ENV NEMOCLAW_DASHBOARD_BIND=${NEMOCLAW_DASHBOARD_BIND}",
        "RUN node --experimental-strip-types /scripts/generate-openclaw-config.mts",
        "RUN chmod 660 /sandbox/.openclaw/openclaw.json",
        "RUN sha256sum /sandbox/.openclaw/openclaw.json > /sandbox/.openclaw/.config-hash",
      ].join("\n"),
    );

    try {
      expect(() =>
        patchStagedDockerfile(dockerfile, "test-model", "http://127.0.0.1:18789"),
      ).not.toThrow();
      expect(hasPreparedRemoteDashboardBind(dockerfile)).toBe(true);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("allows the managed token/proxy patch and hash refresh after the remote-bind generator (#6024)", () => {
    vi.stubEnv("NEMOCLAW_DASHBOARD_BIND", "0.0.0.0");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-remote-bind-managed-"));
    const dockerfile = path.join(directory, "Dockerfile");
    fs.writeFileSync(
      dockerfile,
      remoteBindDockerfile(
        MANAGED_PROXY_PATCH,
        "RUN sha256sum /sandbox/.openclaw/openclaw.json > /sandbox/.openclaw/.config-hash && chmod 660 /sandbox/.openclaw/.config-hash && chown sandbox:sandbox /sandbox/.openclaw/.config-hash",
      ),
    );

    try {
      expect(() =>
        patchStagedDockerfile(dockerfile, "test-model", "http://127.0.0.1:18789"),
      ).not.toThrow();
      expect(hasPreparedRemoteDashboardBind(dockerfile)).toBe(true);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a config reset embedded inside the managed proxy patch shape (#6024)", () => {
    vi.stubEnv("NEMOCLAW_DASHBOARD_BIND", "0.0.0.0");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-remote-bind-embedded-"));
    const dockerfile = path.join(directory, "Dockerfile");
    const embeddedReset = MANAGED_PROXY_PATCH.replace(
      "proxy_host = os.environ.get",
      "cfg = {}; proxy_host = os.environ.get",
    );
    fs.writeFileSync(dockerfile, remoteBindDockerfile(embeddedReset));

    try {
      expect(() =>
        patchStagedDockerfile(dockerfile, "test-model", "http://127.0.0.1:18789"),
      ).toThrow(/preserve the generated remote dashboard output/);
      expect(hasPreparedRemoteDashboardBind(dockerfile)).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects final-stage config regeneration after the remote-bind generator (#6024)", () => {
    vi.stubEnv("NEMOCLAW_DASHBOARD_BIND", "0.0.0.0");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-remote-bind-regenerate-"));
    const dockerfile = path.join(directory, "Dockerfile");
    fs.writeFileSync(
      dockerfile,
      [
        "FROM scratch",
        "ARG NEMOCLAW_MODEL=",
        "ARG CHAT_UI_URL=",
        "ARG NEMOCLAW_DASHBOARD_BIND=",
        "ENV NEMOCLAW_DASHBOARD_BIND=${NEMOCLAW_DASHBOARD_BIND}",
        "RUN node --experimental-strip-types /scripts/generate-openclaw-config.mts",
        "RUN node --experimental-strip-types /scripts/generate-openclaw-config.mts",
      ].join("\n"),
    );

    try {
      expect(() =>
        patchStagedDockerfile(dockerfile, "test-model", "http://127.0.0.1:18789"),
      ).toThrow(/preserve the generated remote dashboard output/);
      expect(hasPreparedRemoteDashboardBind(dockerfile)).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("allows validation-home config generation after the remote-bind generator (#6024)", () => {
    vi.stubEnv("NEMOCLAW_DASHBOARD_BIND", "0.0.0.0");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-remote-bind-validation-"));
    const dockerfile = path.join(directory, "Dockerfile");
    fs.writeFileSync(
      dockerfile,
      [
        "FROM scratch",
        "ARG NEMOCLAW_MODEL=",
        "ARG CHAT_UI_URL=",
        "ARG NEMOCLAW_DASHBOARD_BIND=",
        "ENV NEMOCLAW_DASHBOARD_BIND=${NEMOCLAW_DASHBOARD_BIND}",
        "RUN node --experimental-strip-types /scripts/generate-openclaw-config.mts",
        'RUN validation_home="$validation_root/progressive"; HOME="$validation_home" node --experimental-strip-types /scripts/generate-openclaw-config.mts',
      ].join("\n"),
    );

    try {
      expect(() =>
        patchStagedDockerfile(dockerfile, "test-model", "http://127.0.0.1:18789"),
      ).not.toThrow();
      expect(hasPreparedRemoteDashboardBind(dockerfile)).toBe(true);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when connect requests remote exposure for a local-only sandbox (#6024)", () => {
    const openshellRuntime = requireSource("../src/lib/adapters/openshell/runtime.js");
    const registry = requireSource("../src/lib/state/registry.js");
    vi.stubEnv("NEMOCLAW_DASHBOARD_BIND", "0.0.0.0");
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "beta",
      dashboardPort: 18789,
    });
    const runOpenshell = vi.spyOn(openshellRuntime, "runOpenshell");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(ensureSandboxPortForward("beta")).toBe(false);
    expect(runOpenshell).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("not prepared for remote exposure"));
  });

  it("refuses to reuse a local-only sandbox for remote exposure during onboarding (#6024)", () => {
    const ensureDashboardForward = vi.fn();
    expect(() =>
      applyReusedSandboxDashboardState({
        sandboxName: "beta",
        chatUiUrl: "http://127.0.0.1:18789",
        env: { NEMOCLAW_DASHBOARD_BIND: "0.0.0.0" },
        agent: { name: "openclaw" } as never,
        model: "test-model",
        provider: "nvidia",
        selectionVerified: true,
        sandboxGpuConfig: { mode: "0" } as never,
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        getSandbox: () => ({ name: "beta" }),
        ensureDashboardForward,
        hermesDashboardForwarding: {
          resolveStateForPort: () => ({ enabled: false, config: null }),
          ensureForState: vi.fn(),
        },
        updateReusedSandboxMetadata: vi.fn(),
      }),
    ).toThrow(/--recreate-sandbox/);
    expect(ensureDashboardForward).not.toHaveBeenCalled();
  });

  it("force-restarts a healthy forward on all interfaces only after preparation (#6024)", () => {
    const openshellRuntime = requireSource("../src/lib/adapters/openshell/runtime.js");
    const forwardHealth = requireSource("../src/lib/actions/sandbox/forward-health.js");
    const registry = requireSource("../src/lib/state/registry.js");
    vi.stubEnv("NEMOCLAW_DASHBOARD_BIND", "0.0.0.0");
    vi.stubEnv("NEMOCLAW_FORWARD_RECOVERY_WAIT_MS", "0");
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "beta",
      dashboardPort: 18789,
      dashboardRemoteBindPrepared: true,
    });
    vi.spyOn(forwardHealth, "isLocalForwardReachable").mockReturnValue(true);
    vi.spyOn(openshellRuntime, "captureOpenshell").mockReturnValue({
      status: 0,
      output: "SANDBOX  BIND  PORT  PID  STATUS\nbeta  0.0.0.0  18789  12345  running",
    });
    const runOpenshell = vi
      .spyOn(openshellRuntime, "runOpenshell")
      .mockReturnValue({ status: 0 } as never);

    expect(ensureSandboxPortForward("beta")).toBe(true);
    expect(runOpenshell).toHaveBeenCalledWith(
      ["forward", "stop", "18789", "beta"],
      expect.anything(),
    );
    expect(runOpenshell).toHaveBeenCalledWith(
      ["forward", "start", "--background", "0.0.0.0:18789", "beta"],
      { ignoreError: true, stdio: "ignore" },
    );
  });

  it("rejects a loopback forward after requesting remote exposure (#6024)", () => {
    const openshellRuntime = requireSource("../src/lib/adapters/openshell/runtime.js");
    const forwardHealth = requireSource("../src/lib/actions/sandbox/forward-health.js");
    const registry = requireSource("../src/lib/state/registry.js");
    vi.stubEnv("NEMOCLAW_DASHBOARD_BIND", "0.0.0.0");
    vi.stubEnv("NEMOCLAW_FORWARD_RECOVERY_WAIT_MS", "0");
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "beta",
      dashboardPort: 18789,
      dashboardRemoteBindPrepared: true,
    });
    vi.spyOn(forwardHealth, "isLocalForwardReachable").mockReturnValue(true);
    vi.spyOn(openshellRuntime, "captureOpenshell").mockReturnValue({
      status: 0,
      output: "SANDBOX  BIND  PORT  PID  STATUS\nbeta  127.0.0.1  18789  12345  running",
    });
    const runOpenshell = vi
      .spyOn(openshellRuntime, "runOpenshell")
      .mockReturnValue({ status: 0 } as never);

    expect(ensureSandboxPortForward("beta")).toBe(false);
    expect(runOpenshell).toHaveBeenCalledWith(
      ["forward", "start", "--background", "0.0.0.0:18789", "beta"],
      { ignoreError: true, stdio: "ignore" },
    );
  });

  it("does not replace another sandbox's forward during remote-bind recovery (#6024)", () => {
    const openshellRuntime = requireSource("../src/lib/adapters/openshell/runtime.js");
    const registry = requireSource("../src/lib/state/registry.js");
    vi.stubEnv("NEMOCLAW_DASHBOARD_BIND", "0.0.0.0");
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "beta",
      dashboardPort: 18789,
      dashboardRemoteBindPrepared: true,
    });
    vi.spyOn(openshellRuntime, "captureOpenshell").mockReturnValue({
      status: 0,
      output: "SANDBOX  BIND  PORT  PID  STATUS\nalpha  0.0.0.0  18789  12345  running",
    });
    const runOpenshell = vi.spyOn(openshellRuntime, "runOpenshell");

    expect(ensureSandboxPortForward("beta")).toBe(false);
    expect(runOpenshell).not.toHaveBeenCalled();
  });

  it("forceRestart re-verifies remote-bind preparation before opening the forward (#6024)", () => {
    const openshellRuntime = requireSource("../src/lib/adapters/openshell/runtime.js");
    const forwardHealth = requireSource("../src/lib/actions/sandbox/forward-health.js");
    const registry = requireSource("../src/lib/state/registry.js");
    vi.stubEnv("NEMOCLAW_DASHBOARD_BIND", "0.0.0.0");
    vi.stubEnv("NEMOCLAW_FORWARD_RECOVERY_WAIT_MS", "0");
    vi.spyOn(registry, "getSandbox")
      .mockReturnValueOnce({
        name: "beta",
        dashboardPort: 18789,
        dashboardRemoteBindPrepared: true,
      })
      .mockReturnValueOnce({
        name: "beta",
        dashboardPort: 18789,
        dashboardRemoteBindPrepared: true,
      })
      .mockReturnValue({ name: "beta", dashboardPort: 18789 });
    vi.spyOn(forwardHealth, "isLocalForwardReachable").mockReturnValue(false);
    vi.spyOn(openshellRuntime, "captureOpenshell").mockReturnValue({ status: 0, output: "" });
    const runOpenshell = vi
      .spyOn(openshellRuntime, "runOpenshell")
      .mockReturnValue({ status: 0 } as never);

    expect(ensureSandboxPortForward("beta")).toBe(false);
    expect(
      runOpenshell.mock.calls.some(
        ([rawArgs]) => Array.isArray(rawArgs) && rawArgs[0] === "forward" && rawArgs[1] === "start",
      ),
    ).toBe(false);
  });

  it("restores loopback when default connect finds an all-interface forward (#6024)", () => {
    const openshellRuntime = requireSource("../src/lib/adapters/openshell/runtime.js");
    const forwardHealth = requireSource("../src/lib/actions/sandbox/forward-health.js");
    const registry = requireSource("../src/lib/state/registry.js");
    let started = false;
    vi.stubEnv("NEMOCLAW_DASHBOARD_BIND", "");
    vi.stubEnv("NEMOCLAW_FORWARD_RECOVERY_WAIT_MS", "0");
    vi.stubEnv("WSL_DISTRO_NAME", "");
    vi.stubEnv("WSL_INTEROP", "");
    vi.spyOn(os, "release").mockReturnValue("6.8.0-linux");
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "beta",
      dashboardPort: 18789,
      dashboardRemoteBindPrepared: true,
    });
    vi.spyOn(forwardHealth, "isLocalForwardReachable").mockReturnValue(true);
    vi.spyOn(openshellRuntime, "captureOpenshell").mockImplementation(() => ({
      status: 0,
      output: started
        ? "SANDBOX  BIND  PORT  PID  STATUS\nbeta  127.0.0.1  18789  12345  running"
        : "SANDBOX  BIND  PORT  PID  STATUS\nbeta  0.0.0.0  18789  12345  running",
    }));
    const runOpenshell = vi
      .spyOn(openshellRuntime, "runOpenshell")
      .mockImplementation((rawArgs: unknown) => {
        const args = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
        started ||= args[0] === "forward" && args[1] === "start";
        return { status: 0 } as never;
      });

    expect(ensureSandboxPortForward("beta")).toBe(true);
    expect(runOpenshell).toHaveBeenCalledWith(
      ["forward", "stop", "18789", "beta"],
      expect.anything(),
    );
    expect(runOpenshell).toHaveBeenCalledWith(
      ["forward", "start", "--background", "18789", "beta"],
      { ignoreError: true, stdio: "ignore" },
    );
  });

  it("restores an all-interface forward for WSL without remote-bind opt-in (#6024)", () => {
    const openshellRuntime = requireSource("../src/lib/adapters/openshell/runtime.js");
    const forwardHealth = requireSource("../src/lib/actions/sandbox/forward-health.js");
    const registry = requireSource("../src/lib/state/registry.js");
    let started = false;
    vi.stubEnv("NEMOCLAW_DASHBOARD_BIND", "");
    vi.stubEnv("NEMOCLAW_FORWARD_RECOVERY_WAIT_MS", "0");
    vi.stubEnv("WSL_DISTRO_NAME", "Ubuntu");
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "beta",
      dashboardPort: 18789,
    });
    vi.spyOn(forwardHealth, "isLocalForwardReachable").mockImplementation(() => started);
    vi.spyOn(openshellRuntime, "captureOpenshell").mockImplementation(() => ({
      status: 0,
      output: started
        ? "SANDBOX  BIND  PORT  PID  STATUS\nbeta  0.0.0.0  18789  12345  running"
        : "",
    }));
    const runOpenshell = vi
      .spyOn(openshellRuntime, "runOpenshell")
      .mockImplementation((rawArgs: unknown) => {
        const args = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
        started ||= args[0] === "forward" && args[1] === "start";
        return { status: 0 } as never;
      });

    expect(ensureSandboxPortForward("beta")).toBe(true);
    expect(runOpenshell).toHaveBeenCalledWith(
      ["forward", "start", "--background", "0.0.0.0:18789", "beta"],
      { ignoreError: true, stdio: "ignore" },
    );
  });

  it("keeps a prepared sandbox on loopback without remote-bind opt-in (#6024)", () => {
    const openshellRuntime = requireSource("../src/lib/adapters/openshell/runtime.js");
    const forwardHealth = requireSource("../src/lib/actions/sandbox/forward-health.js");
    const registry = requireSource("../src/lib/state/registry.js");
    let started = false;
    vi.stubEnv("NEMOCLAW_DASHBOARD_BIND", "");
    vi.stubEnv("NEMOCLAW_FORWARD_RECOVERY_WAIT_MS", "0");
    vi.stubEnv("WSL_DISTRO_NAME", "");
    vi.stubEnv("WSL_INTEROP", "");
    vi.spyOn(os, "release").mockReturnValue("6.8.0-linux");
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "beta",
      dashboardPort: 18789,
      dashboardRemoteBindPrepared: true,
    });
    vi.spyOn(forwardHealth, "isLocalForwardReachable").mockImplementation(() => started);
    vi.spyOn(openshellRuntime, "captureOpenshell").mockImplementation(() => ({
      status: 0,
      output: started
        ? "SANDBOX  BIND  PORT  PID  STATUS\nbeta  127.0.0.1  18789  12345  running"
        : "",
    }));
    const runOpenshell = vi
      .spyOn(openshellRuntime, "runOpenshell")
      .mockImplementation((rawArgs: unknown) => {
        const args = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
        started ||= args[0] === "forward" && args[1] === "start";
        return { status: 0 } as never;
      });

    expect(ensureSandboxPortForward("beta")).toBe(true);
    expect(runOpenshell).toHaveBeenCalledWith(
      ["forward", "start", "--background", "18789", "beta"],
      { ignoreError: true, stdio: "ignore" },
    );
  });
});

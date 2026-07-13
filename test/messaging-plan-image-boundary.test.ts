// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  createMessagingBoundaryPlan,
  encodeMessagingBoundaryPlan,
  FULL_PLAN_ONLY_SENTINEL,
  HERMES_AIOHTTP_PACKAGE_SPEC,
  HERMES_TEAMS_PACKAGE_SPEC,
  OPENCLAW_TEAMS_PACKAGE_SPEC,
  OPENCLAW_TEAMS_PACKAGE_VERSION,
  TEAMS_APP_ID,
  TEAMS_SECRET_PLACEHOLDER,
  TEAMS_TENANT_ID,
  verifyMessagingPlanImageBoundary,
} from "../scripts/check-messaging-plan-image-boundary.mts";
import { teamsManifest } from "../src/lib/messaging/channels/teams/manifest";

type Agent = "openclaw" | "hermes";
type DockerResult = { status: number; stdout?: string; stderr?: string };

const IMAGE = "nemoclaw-messaging-boundary:test";
const RUNTIME_PLAN_PATH = "/usr/local/share/nemoclaw/messaging-runtime-plan.json";
const PRELOAD_PATH = "/usr/local/lib/nemoclaw/preloads/msteams-message-hints.js";
const OPENCLAW_TEAMS_ROOT =
  "/sandbox/.openclaw/npm/projects/openclaw-msteams-d29647a7c0/node_modules/@openclaw/msteams";

function decodePlan(agent: Agent): any {
  return JSON.parse(Buffer.from(encodeMessagingBoundaryPlan(agent), "base64").toString("utf8"));
}

function reducedArtifact(agent: Agent): string {
  return JSON.stringify({
    schemaVersion: 1,
    sandboxName: "nemoclaw-ci-messaging-plan-boundary",
    agent,
    workflow: "rebuild",
    channels: [{ channelId: "teams", active: true, disabled: false }],
    disabledChannels: [],
    credentialBindings: [{ channelId: "teams", providerEnvKey: "MSTEAMS_APP_PASSWORD" }],
    runtimeSetup: {
      nodePreloads:
        agent === "openclaw"
          ? [
              {
                channelId: "teams",
                source: PRELOAD_PATH,
                target: "/tmp/nemoclaw-msteams-message-hints.js",
                injectInto: ["boot", "connect"],
                optional: false,
              },
            ]
          : [],
      envAliases: [],
      secretScans: [],
    },
  });
}

function openClawInspectReport(): any {
  return {
    plugin: {
      id: "msteams",
      name: "Microsoft Teams",
      packageName: "@openclaw/msteams",
      version: OPENCLAW_TEAMS_PACKAGE_VERSION,
      status: "loaded",
      rootDir: OPENCLAW_TEAMS_ROOT,
    },
    capabilities: [{ kind: "channel", ids: ["msteams"] }],
  };
}

function successfulDockerRunner(agent: Agent, openClawInspect = openClawInspectReport()) {
  const expected: Array<{ args: string[]; result: DockerResult }> = [
    {
      args: ["image", "inspect", IMAGE],
      result: { status: 0, stdout: JSON.stringify([{ Config: { Env: ["PATH=/usr/bin"] } }]) },
    },
    {
      args: ["run", "--rm", "--network", "none", "--entrypoint", "/usr/bin/env", IMAGE, "-0"],
      result: { status: 0, stdout: "PATH=/usr/bin\0HOME=/sandbox\0" },
    },
    {
      args: imageFileArgs(RUNTIME_PLAN_PATH),
      result: { status: 0, stdout: reducedArtifact(agent) },
    },
  ];

  expected.push(
    ...(agent === "openclaw"
      ? [
          {
            args: imageFileArgs("/sandbox/.openclaw/openclaw.json"),
            result: {
              status: 0,
              stdout: JSON.stringify({
                channels: {
                  msteams: {
                    enabled: true,
                    appId: TEAMS_APP_ID,
                    appPassword: TEAMS_SECRET_PLACEHOLDER,
                    tenantId: TEAMS_TENANT_ID,
                  },
                },
                plugins: { entries: { msteams: { enabled: true } } },
              }),
            },
          },
          {
            args: [
              "run",
              "--rm",
              "--network",
              "none",
              "--user",
              "sandbox",
              "--env",
              "HOME=/sandbox",
              "--entrypoint",
              "openclaw",
              IMAGE,
              "plugins",
              "inspect",
              "msteams",
              "--runtime",
              "--json",
            ],
            result: {
              status: 0,
              stdout: `[proxy] routing through the managed sandbox proxy\n${JSON.stringify(openClawInspect)}`,
            },
          },
          {
            args: imageFileArgs(PRELOAD_PATH),
            result: { status: 0, stdout: "export function install() {}\n" },
          },
        ]
      : [
          {
            args: imageFileArgs("/sandbox/.hermes/.env"),
            result: {
              status: 0,
              stdout: [
                `TEAMS_CLIENT_ID=${TEAMS_APP_ID}`,
                `TEAMS_CLIENT_SECRET=${TEAMS_SECRET_PLACEHOLDER}`,
                `TEAMS_TENANT_ID=${TEAMS_TENANT_ID}`,
                "TEAMS_PORT=3978",
                "",
              ].join("\n"),
            },
          },
          {
            args: imageFileArgs("/sandbox/.hermes/config.yaml"),
            result: { status: 0, stdout: "platforms:\n  teams:\n    enabled: true\n" },
          },
          {
            args: [
              "run",
              "--rm",
              "--network",
              "none",
              "--entrypoint",
              "/opt/hermes/.venv/bin/python",
              IMAGE,
              "-c",
              expect.any(String),
            ] as unknown as string[],
            result: {
              status: 0,
              stdout: JSON.stringify({ "microsoft-teams-apps": "2.0.13.4", aiohttp: "3.14.1" }),
            },
          },
        ]),
  );

  let cursor = 0;
  const runner = (args: string[]): DockerResult => {
    const next = expected[cursor++];
    expect(next, `unexpected docker call: ${args.join(" ")}`).toBeDefined();
    expect(args).toEqual(next!.args);
    return next!.result;
  };
  return { runner, assertComplete: () => expect(cursor).toBe(expected.length) };
}

function imageFileArgs(path: string): string[] {
  return ["run", "--rm", "--network", "none", "--entrypoint", "/bin/cat", IMAGE, path];
}

describe("messaging plan image boundary helper", () => {
  it.each([
    "openclaw",
    "hermes",
  ] as const)("builds a deterministic placeholder-only %s plan", (agent) => {
    expect(encodeMessagingBoundaryPlan(agent)).toBe(encodeMessagingBoundaryPlan(agent));
    const plan = decodePlan(agent);
    expect(plan).toEqual(createMessagingBoundaryPlan(agent));
    expect(plan.fullPlanOnlySentinel).toBe(FULL_PLAN_ONLY_SENTINEL);
    expect(plan.credentialBindings).toEqual([
      expect.objectContaining({
        providerEnvKey: "MSTEAMS_APP_PASSWORD",
        placeholder: TEAMS_SECRET_PLACEHOLDER,
      }),
    ]);
    expect(JSON.stringify(plan)).not.toContain("client-secret-value");
    expect(JSON.stringify(plan)).not.toContain("password-value");
  });

  it("tracks exact current Teams manifest package specs", () => {
    const manifestSpecs = (teamsManifest.agentPackages ?? []).map(({ agent, manager, spec }) => ({
      agent,
      manager,
      spec,
    }));
    const planSpecs = (["openclaw", "hermes"] as const).flatMap((agent) =>
      decodePlan(agent).buildSteps.map(({ value }: any) => ({
        agent,
        manager: value.manager,
        spec: value.spec,
      })),
    );

    expect(planSpecs).toEqual(manifestSpecs);
    expect(OPENCLAW_TEAMS_PACKAGE_SPEC).toBe("npm:@openclaw/msteams@{{openclaw.version}}");
    expect(HERMES_TEAMS_PACKAGE_SPEC).toBe("microsoft-teams-apps==2.0.13.4");
    expect(HERMES_AIOHTTP_PACKAGE_SPEC).toBe("aiohttp==3.14.1");
  });

  it("emits agent-specific Teams render, install, and runtime outputs", () => {
    const openclaw = decodePlan("openclaw");
    expect(openclaw.agentRender).toEqual([
      expect.objectContaining({
        target: "openclaw.json",
        path: "channels.msteams",
        value: expect.objectContaining({
          appId: TEAMS_APP_ID,
          appPassword: TEAMS_SECRET_PLACEHOLDER,
        }),
      }),
      expect.objectContaining({ target: "openclaw.json", path: "plugins.entries.msteams" }),
    ]);
    expect(openclaw.runtimeSetup.nodePreloads).toEqual([
      expect.objectContaining({
        module: "msteams-message-hints",
        source: PRELOAD_PATH,
        injectInto: ["boot", "connect"],
      }),
    ]);

    const hermes = decodePlan("hermes");
    expect(hermes.agentRender).toEqual([
      expect.objectContaining({
        target: "~/.hermes/.env",
        lines: expect.arrayContaining([
          `TEAMS_CLIENT_ID=${TEAMS_APP_ID}`,
          `TEAMS_CLIENT_SECRET=${TEAMS_SECRET_PLACEHOLDER}`,
        ]),
      }),
      expect.objectContaining({ target: "~/.hermes/config.yaml", path: "platforms.teams" }),
    ]);
    expect(hermes.buildSteps.map((step: any) => step.value.spec)).toEqual([
      HERMES_TEAMS_PACKAGE_SPEC,
      HERMES_AIOHTTP_PACKAGE_SPEC,
    ]);
  });

  it.each([
    "openclaw",
    "hermes",
  ] as const)("verifies real-image evidence for %s through an injectable Docker runner", (agent) => {
    const mock = successfulDockerRunner(agent);
    expect(verifyMessagingPlanImageBoundary(IMAGE, agent, mock.runner)).toEqual({
      image: IMAGE,
      agent,
      runtimePlanPath: RUNTIME_PLAN_PATH,
    });
    mock.assertComplete();
  });

  it.each([
    [
      "legacy extension layout",
      (report: any) => (report.plugin.rootDir = "/sandbox/.openclaw/extensions/msteams"),
    ],
    ["wrong package version", (report: any) => (report.plugin.version = "2026.6.9")],
    ["missing runtime channel", (report: any) => (report.capabilities = [])],
  ])("rejects OpenClaw Teams plugin evidence with %s", (_label, mutate) => {
    const report = openClawInspectReport();
    mutate(report);
    const mock = successfulDockerRunner("openclaw", report);

    expect(() => verifyMessagingPlanImageBoundary(IMAGE, "openclaw", mock.runner)).toThrow(
      "OpenClaw Teams plugin evidence must be loaded from the managed npm project",
    );
  });

  it("fails before container execution when Config.Env retains the full plan", () => {
    const runner = (args: string[]): DockerResult => {
      expect(args).toEqual(["image", "inspect", IMAGE]);
      return {
        status: 0,
        stdout: JSON.stringify([
          {
            Config: {
              Env: [`NEMOCLAW_MESSAGING_PLAN_B64=${encodeMessagingBoundaryPlan("openclaw")}`],
            },
          },
        ]),
      };
    };

    expect(() => verifyMessagingPlanImageBoundary(IMAGE, "openclaw", runner)).toThrow(
      "image Config.Env retains forbidden NEMOCLAW_MESSAGING_PLAN_B64",
    );
  });

  it("rejects the encoded full plan even when the image renames the environment key", () => {
    const runner = (): DockerResult => ({
      status: 0,
      stdout: JSON.stringify([
        {
          Config: {
            Env: [`RENAMED_PLAN=${encodeMessagingBoundaryPlan("openclaw")}`],
          },
        },
      ]),
    });

    expect(() => verifyMessagingPlanImageBoundary(IMAGE, "openclaw", runner)).toThrow(
      "image Config.Env contains full messaging plan data: encoded openclaw messaging plan",
    );
  });

  it("fails when the running container process inherits the full plan", () => {
    const results: DockerResult[] = [
      {
        status: 0,
        stdout: JSON.stringify([{ Config: { Env: ["PATH=/usr/bin"] } }]),
      },
      {
        status: 0,
        stdout: `PATH=/usr/bin\0NEMOCLAW_MESSAGING_PLAN_B64=${encodeMessagingBoundaryPlan("openclaw")}\0`,
      },
    ];
    const runner = (): DockerResult => results.shift()!;

    expect(() => verifyMessagingPlanImageBoundary(IMAGE, "openclaw", runner)).toThrow(
      "container process environment retains forbidden NEMOCLAW_MESSAGING_PLAN_B64",
    );
    expect(results).toHaveLength(0);
  });

  it.each([
    ["top-level", "fullPlanShadow", (artifact: any) => (artifact.fullPlanShadow = true)],
    ["channel", "inputs", (artifact: any) => (artifact.channels[0].inputs = ["secret"])],
    [
      "credential binding",
      "credentialHash",
      (artifact: any) => (artifact.credentialBindings[0].credentialHash = "digest"),
    ],
    ["runtime setup", "plan", (artifact: any) => (artifact.runtimeSetup.plan = {})],
    [
      "runtime preload",
      "module",
      (artifact: any) => (artifact.runtimeSetup.nodePreloads[0].module = "full-plan-only"),
    ],
  ])("rejects non-allowlisted %s fields in the reduced artifact", (_label, field, mutate) => {
    const artifact = JSON.parse(reducedArtifact("openclaw"));
    mutate(artifact);
    const results: DockerResult[] = [
      {
        status: 0,
        stdout: JSON.stringify([{ Config: { Env: ["PATH=/usr/bin"] } }]),
      },
      { status: 0, stdout: "PATH=/usr/bin\0" },
      { status: 0, stdout: JSON.stringify(artifact) },
    ];
    const runner = (): DockerResult => results.shift()!;

    expect(() => verifyMessagingPlanImageBoundary(IMAGE, "openclaw", runner)).toThrow(
      `contains non-allowlisted fields: ${field}`,
    );
    expect(results).toHaveLength(0);
  });

  it("fails closed when Docker cannot provide evidence", () => {
    const runner = (): DockerResult => ({
      status: 125,
      stderr: "Cannot connect to the Docker daemon",
    });
    expect(() => verifyMessagingPlanImageBoundary(IMAGE, "hermes", runner)).toThrow(
      "Cannot connect to the Docker daemon",
    );
  });
});

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { resolvePersistedAutoRestoreTarget } from "./index";

describe("persisted auto-restore target resolution", () => {
  it("augments a legacy marker without agentName when registry paths still match (#8074)", () => {
    const registryTarget = {
      agentName: "openclaw",
      configPath: "/sandbox/.openclaw/openclaw.json",
      configDir: "/sandbox/.openclaw",
      configFile: "openclaw.json",
      format: "json" as const,
      sensitiveFiles: ["/sandbox/.openclaw/credentials.json"],
      stateLockPlanInImage: true,
    };

    expect(
      resolvePersistedAutoRestoreTarget(
        "legacy-openclaw",
        {
          configPath: registryTarget.configPath,
          configDir: registryTarget.configDir,
        },
        () => registryTarget,
      ),
    ).toEqual({
      ...registryTarget,
      sensitiveFiles: ["/sandbox/.openclaw/credentials.json", "/sandbox/.openclaw/.config-hash"],
    });
  });

  it("keeps legacy marker paths when the registry now describes another target (#8074)", () => {
    const registryTarget = {
      agentName: "openclaw",
      configPath: "/sandbox/.openclaw/openclaw.json",
      configDir: "/sandbox/.openclaw",
      configFile: "openclaw.json",
      format: "json" as const,
      stateLockPlanInImage: true,
    };

    expect(
      resolvePersistedAutoRestoreTarget(
        "legacy-target",
        {
          configPath: "/sandbox/.legacy/config.json",
          configDir: "/sandbox/.legacy/",
        },
        () => registryTarget,
      ),
    ).toEqual({
      configPath: "/sandbox/.legacy/config.json",
      configDir: "/sandbox/.legacy/",
      sensitiveFiles: ["/sandbox/.legacy/.config-hash"],
      stateLockPlanInImage: false,
    });
  });

  it("keeps a named Hermes marker when the registry agent differs at the same paths (#8074)", () => {
    const registryTarget = {
      agentName: "openclaw",
      configPath: "/sandbox/.hermes/config.yaml",
      configDir: "/sandbox/.hermes/",
      configFile: "config.yaml",
      format: "yaml" as const,
      stateLockPlanInImage: true,
    };

    expect(
      resolvePersistedAutoRestoreTarget(
        "hermes",
        {
          agentName: "hermes",
          configPath: "/sandbox/.hermes/config.yaml",
          configDir: "/sandbox/.hermes/",
        },
        () => registryTarget,
      ),
    ).toEqual({
      agentName: "hermes",
      configPath: "/sandbox/.hermes/config.yaml",
      configDir: "/sandbox/.hermes/",
      sensitiveFiles: ["/sandbox/.hermes/.config-hash", "/sandbox/.hermes/.env"],
      stateLockPlan: expect.any(Object),
      stateLockPlanInImage: true,
    });
  });

  it("keeps legacy marker paths when registry resolution throws (#8074)", () => {
    const failRegistryResolution = () => {
      throw new Error("registry unavailable");
    };

    expect(
      resolvePersistedAutoRestoreTarget(
        "legacy-target",
        {
          configPath: "/sandbox/.legacy/config.json",
          configDir: "/sandbox/.legacy/",
        },
        failRegistryResolution,
      ),
    ).toEqual({
      configPath: "/sandbox/.legacy/config.json",
      configDir: "/sandbox/.legacy/",
      sensitiveFiles: ["/sandbox/.legacy/.config-hash"],
      stateLockPlanInImage: false,
    });
  });
});

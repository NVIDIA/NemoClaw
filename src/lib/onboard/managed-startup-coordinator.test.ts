// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  type CommittedManagedStartupApplication,
  type PreparedManagedStartupApplication,
  type PrepareManagedStartupApplicationInput,
} from "./managed-startup/application";
import {
  coordinateManagedStartupApplication,
  type ManagedStartupAgentAdapter,
  type ManagedStartupCoordinatorDependencies,
} from "./managed-startup/coordinator";
import { type ManagedStartupAgent, type ManagedStartupProfile } from "./managed-startup/profile";

function inputFor(agent: ManagedStartupAgent): PrepareManagedStartupApplicationInput {
  return {
    encodedProfile: `encoded-${agent}`,
    expectedAgent: agent,
  };
}

function preparedFor(
  agent: ManagedStartupAgent,
  status: PreparedManagedStartupApplication["status"] = "prepared",
): PreparedManagedStartupApplication {
  return {
    status,
    stateDirectory: "/var/lib/nemoclaw/startup-profile",
    generationDirectory: `/var/lib/nemoclaw/startup-profile/generation-${"a".repeat(64)}`,
    profilePath: `/var/lib/nemoclaw/startup-profile/generation-${"a".repeat(64)}/profile.json`,
    corporateCaPath: null,
    fingerprint: "a".repeat(64),
    expectedAgent: agent,
    profile: { agent } as ManagedStartupProfile,
  };
}

function committedFrom(
  prepared: PreparedManagedStartupApplication,
): CommittedManagedStartupApplication {
  const { status: _status, ...application } = prepared;
  return { ...application, status: "committed" };
}

function dependenciesFor(
  prepared: PreparedManagedStartupApplication,
  order: string[] = [],
): ManagedStartupCoordinatorDependencies & {
  prepareApplication: ReturnType<typeof vi.fn>;
  commitApplication: ReturnType<typeof vi.fn>;
} {
  return {
    prepareApplication: vi.fn(async () => {
      order.push("prepare");
      return prepared;
    }),
    commitApplication: vi.fn(async (application: PreparedManagedStartupApplication) => {
      order.push("commit");
      return committedFrom(application);
    }),
  };
}

function adaptersFor(order: string[] = []): {
  readonly adapters: ManagedStartupAgentAdapter[];
  readonly applyByAgent: Record<ManagedStartupAgent, ReturnType<typeof vi.fn>>;
} {
  const applyByAgent = {
    openclaw: vi.fn(async () => {
      order.push("apply:openclaw");
    }),
    hermes: vi.fn(async () => {
      order.push("apply:hermes");
    }),
    "langchain-deepagents-code": vi.fn(async () => {
      order.push("apply:langchain-deepagents-code");
    }),
  };
  return {
    adapters: [
      { agent: "openclaw", apply: applyByAgent.openclaw },
      { agent: "hermes", apply: applyByAgent.hermes },
      {
        agent: "langchain-deepagents-code",
        apply: applyByAgent["langchain-deepagents-code"],
      },
    ],
    applyByAgent,
  };
}

describe("managed startup coordinator", () => {
  it.each([
    "openclaw",
    "hermes",
    "langchain-deepagents-code",
  ] as const)("dispatches exactly the %s adapter before commit", async (agent) => {
    const order: string[] = [];
    const prepared = preparedFor(agent);
    const dependencies = dependenciesFor(prepared, order);
    const { adapters, applyByAgent } = adaptersFor(order);

    const result = await coordinateManagedStartupApplication(
      inputFor(agent),
      adapters,
      dependencies,
    );

    expect(result.adapterApplied).toBe(true);
    expect(result.application.status).toBe("committed");
    expect(order).toEqual(["prepare", `apply:${agent}`, "commit"]);
    expect(applyByAgent[agent]).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        agent,
        profile: prepared.profile,
        fingerprint: prepared.fingerprint,
      }),
    );
    for (const otherAgent of ["openclaw", "hermes", "langchain-deepagents-code"] as const) {
      expect(applyByAgent[otherAgent]).toHaveBeenCalledTimes(otherAgent === agent ? 1 : 0);
    }
    expect(dependencies.commitApplication).toHaveBeenCalledWith(prepared);
  });

  it("does not reapply mutable config for an already committed profile", async () => {
    const prepared = preparedFor("openclaw", "already-committed");
    const dependencies = dependenciesFor(prepared);
    const { adapters, applyByAgent } = adaptersFor();

    const result = await coordinateManagedStartupApplication(
      inputFor("openclaw"),
      adapters,
      dependencies,
    );

    expect(result.adapterApplied).toBe(false);
    expect(dependencies.commitApplication).toHaveBeenCalledExactlyOnceWith(prepared);
    for (const apply of Object.values(applyByAgent)) {
      expect(apply).not.toHaveBeenCalled();
    }
  });

  it("rejects a missing adapter before preparing state", async () => {
    const prepared = preparedFor("openclaw");
    const dependencies = dependenciesFor(prepared);
    const { adapters } = adaptersFor();

    await expect(
      coordinateManagedStartupApplication(
        inputFor("openclaw"),
        adapters.filter((adapter) => adapter.agent !== "hermes"),
        dependencies,
      ),
    ).rejects.toThrow(/missing adapter for hermes/u);
    expect(dependencies.prepareApplication).not.toHaveBeenCalled();
  });

  it("rejects a duplicate adapter before preparing state", async () => {
    const prepared = preparedFor("openclaw");
    const dependencies = dependenciesFor(prepared);
    const { adapters } = adaptersFor();

    await expect(
      coordinateManagedStartupApplication(
        inputFor("openclaw"),
        [...adapters, adapters[0] as ManagedStartupAgentAdapter],
        dependencies,
      ),
    ).rejects.toThrow(/duplicate adapter registered for openclaw/u);
    expect(dependencies.prepareApplication).not.toHaveBeenCalled();
  });

  it("rejects an adapter for an unshipped agent before preparing state", async () => {
    const prepared = preparedFor("openclaw");
    const dependencies = dependenciesFor(prepared);
    const { adapters } = adaptersFor();
    const wrong = {
      agent: "not-a-shipped-agent",
      apply: vi.fn(),
    } as unknown as ManagedStartupAgentAdapter;

    await expect(
      coordinateManagedStartupApplication(inputFor("openclaw"), [...adapters, wrong], dependencies),
    ).rejects.toThrow(/one shipped agent/u);
    expect(dependencies.prepareApplication).not.toHaveBeenCalled();
  });

  it("fails closed instead of cross-dispatching a mismatched prepared profile", async () => {
    const prepared = {
      ...preparedFor("openclaw"),
      profile: { agent: "hermes" } as ManagedStartupProfile,
    };
    const dependencies = dependenciesFor(prepared);
    const { adapters, applyByAgent } = adaptersFor();

    await expect(
      coordinateManagedStartupApplication(inputFor("openclaw"), adapters, dependencies),
    ).rejects.toThrow(/targets hermes, expected openclaw/u);
    expect(dependencies.commitApplication).not.toHaveBeenCalled();
    for (const apply of Object.values(applyByAgent)) {
      expect(apply).not.toHaveBeenCalled();
    }
  });

  it("does not commit an adapter failure and can retry the pending profile", async () => {
    const prepared = preparedFor("hermes");
    const dependencies = dependenciesFor(prepared);
    const { adapters, applyByAgent } = adaptersFor();
    applyByAgent.hermes.mockRejectedValueOnce(new Error("adapter failed"));

    await expect(
      coordinateManagedStartupApplication(inputFor("hermes"), adapters, dependencies),
    ).rejects.toThrow("adapter failed");
    expect(dependencies.commitApplication).not.toHaveBeenCalled();

    const retried = await coordinateManagedStartupApplication(
      inputFor("hermes"),
      adapters,
      dependencies,
    );
    expect(retried.application.status).toBe("committed");
    expect(applyByAgent.hermes).toHaveBeenCalledTimes(2);
    expect(dependencies.commitApplication).toHaveBeenCalledTimes(1);
  });

  it("reapplies a pending adapter after a crash at the commit boundary", async () => {
    const prepared = preparedFor("langchain-deepagents-code");
    const dependencies = dependenciesFor(prepared);
    const { adapters, applyByAgent } = adaptersFor();
    dependencies.commitApplication.mockRejectedValueOnce(
      new Error("simulated process interruption"),
    );

    await expect(
      coordinateManagedStartupApplication(
        inputFor("langchain-deepagents-code"),
        adapters,
        dependencies,
      ),
    ).rejects.toThrow("simulated process interruption");

    const retried = await coordinateManagedStartupApplication(
      inputFor("langchain-deepagents-code"),
      adapters,
      dependencies,
    );
    expect(retried.application.status).toBe("committed");
    expect(applyByAgent["langchain-deepagents-code"]).toHaveBeenCalledTimes(2);
    expect(dependencies.commitApplication).toHaveBeenCalledTimes(2);
  });
});

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  OpenShellForwardAdapter,
  OpenShellForwardIdentity,
  OpenShellForwardStartResult,
} from "../adapters/openshell/forward";
import { formatOpenShellForwardStartFailure } from "../adapters/openshell/forward";
import { resolveSandboxHermesApiPort } from "../onboard/hermes-api-port";

type HermesForwardSandbox = { agent?: string | null; hermesApiPort?: number | null };

export function isRegisteredHermesApiForward(
  sandbox: HermesForwardSandbox | null | undefined,
  port: number,
  localHost: string,
): boolean {
  return (
    localHost === "127.0.0.1" &&
    sandbox?.agent === "hermes" &&
    resolveSandboxHermesApiPort(sandbox) === port
  );
}

/** Keep lifecycle authority fences while sharing the Hermes migration policy. */
export function createHermesApiForwardMigration(options: {
  forward: OpenShellForwardIdentity;
  readSandbox: () => HermesForwardSandbox | null | undefined;
  adapter: Pick<
    OpenShellForwardAdapter,
    "observeForwards" | "retireLegacyForward" | "startForward"
  >;
  assertCurrent: () => void | Promise<void>;
  /** Preserve recovery eligibility established before its beforeStart callback. */
  requireRegisteredApi?: boolean;
}): {
  assertCurrent: () => Promise<void>;
  migrate: () => Promise<OpenShellForwardStartResult | null>;
} {
  const { forward, readSandbox, adapter } = options;
  const isCurrentApi = () =>
    isRegisteredHermesApiForward(readSandbox(), forward.port, forward.localHost);
  const eligible = options.requireRegisteredApi || isCurrentApi();
  const assertCurrent = async () => {
    await options.assertCurrent();
    if (eligible && !isCurrentApi()) {
      throw new Error("Hermes API forward authority changed during migration");
    }
  };
  return {
    assertCurrent,
    async migrate() {
      if (!eligible) return null;
      await assertCurrent();
      // A loopback observation reports wildcard listeners as foreign. Require
      // proof of the wildcard identity before the adapter may retire its PID.
      const wildcard = { ...forward, localHost: "0.0.0.0" as const };
      const [previous] = await adapter.observeForwards({
        forwards: [wildcard],
        assertCurrent,
      });
      if (previous?.state !== "owned" && previous?.state !== "stale") return null;
      const retirement = await adapter.retireLegacyForward({
        forward: wildcard,
        migrateToLoopback: true,
        assertCurrent,
        authorize: async () => assertCurrent(),
      });
      if (retirement.state !== "retired" && retirement.state !== "not_needed") {
        if ("error" in retirement) throw new Error(retirement.error.message);
        if (retirement.observation.state === "foreign") {
          throw new Error("The host port is owned by a foreign listener.");
        }
        throw new Error("NemoClaw could not prove the OpenShell forward state.");
      }
      const started = await adapter.startForward({ forward, assertCurrent });
      // An uncertain child may still bind later. Reconcile only a start that
      // proved it had no effect, and never restore the external API bind.
      if (started.state !== "failed") return started;
      const startupDetail =
        "failure" in started && started.failure
          ? ` [${formatOpenShellForwardStartFailure(started.failure)}]`
          : "";
      console.warn(
        `Hermes API wildcard forward was retired, but loopback startup failed: ${started.error.message}${startupDetail}`,
      );
      const [current] = await adapter.observeForwards({ forwards: [forward], assertCurrent });
      await assertCurrent();
      if (current?.state === "owned") return { state: "reused", forward };
      if (current?.state !== "absent") return started;
      const retried = await adapter.startForward({ forward, assertCurrent });
      if (retried.state !== "started" && retried.state !== "reused") {
        console.warn(
          `Hermes API loopback reconciliation could not prove restoration. Resolve the startup error, then run nemoclaw ${forward.sandboxName} recover.`,
        );
      }
      if (
        (retried.state === "failed" || retried.state === "cleanup_uncertain") &&
        "failure" in started &&
        started.failure
      ) {
        return {
          ...retried,
          failure: ("failure" in retried && retried.failure) || started.failure,
        };
      }
      return retried;
    },
  };
}

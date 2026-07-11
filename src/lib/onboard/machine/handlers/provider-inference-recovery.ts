// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Session } from "../../../state/onboard-session";
import {
  type SandboxRecoveryAuthority,
  shouldRecoverRecordedProvider,
} from "../../provider-recovery";

export type RecoveryAuthority = SandboxRecoveryAuthority;

interface ProviderRecoveryDeps {
  getSandboxRecoveryAuthority(
    sandboxName: string,
    sessionId: string | null | undefined,
  ): SandboxRecoveryAuthority;
}

interface ProviderRecoverySetupOptions {
  reservationSessionId?: string;
  isRecordedProviderRecoveryAuthorized?: () => boolean;
}

interface ProviderRecoveryOptions {
  /**
   * Rebuild recreate replaces the durable session after deleting the old sandbox, so its sandbox
   * step must remain incomplete until creation succeeds. The locked rebuild pipeline validates the
   * target before deletion, then writes that exact identity into the pending session before onboard.
   * Remove this exception once #6666 replaces the handoff with a dedicated provider-recovery
   * authorization receipt.
   */
  authoritativeResumeConfig?: boolean;
}

export function createRecovery(
  fresh: boolean,
  sandboxName: string | null,
  session: Session | null,
  deps: ProviderRecoveryDeps,
  options: ProviderRecoveryOptions = {},
): {
  sessionId: string | null;
  shouldRecover(): boolean;
  setupOptions(
    recoveredRecordedProvider: boolean,
    selectedSandboxName: string,
    currentSessionId: string | undefined,
  ): ProviderRecoverySetupOptions;
} {
  const sessionId = session?.sessionId ?? null;
  return {
    sessionId,
    shouldRecover: () =>
      shouldRecoverRecordedProvider({
        fresh,
        sandboxName,
        sandboxRecoveryAuthority: sandboxName
          ? deps.getSandboxRecoveryAuthority(sandboxName, sessionId)
          : "missing",
        sessionSandboxName:
          session?.steps?.sandbox?.status === "complete" || options.authoritativeResumeConfig
            ? (session?.sandboxName ?? null)
            : null,
      }),
    setupOptions(recoveredRecordedProvider, selectedSandboxName, currentSessionId) {
      if (!recoveredRecordedProvider) return { reservationSessionId: currentSessionId };
      return {
        reservationSessionId: sessionId ?? undefined,
        isRecordedProviderRecoveryAuthorized: () =>
          deps.getSandboxRecoveryAuthority(selectedSandboxName, sessionId) !== "unauthorized",
      };
    },
  };
}

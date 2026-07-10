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

export function createRecovery(
  fresh: boolean,
  sandboxName: string | null,
  session: Session | null,
  deps: ProviderRecoveryDeps,
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
          session?.steps?.sandbox?.status === "complete" ? (session.sandboxName ?? null) : null,
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

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  createSession,
  filterSafeUpdates,
  normalizeSession,
  type Session,
  type SessionUpdates,
} from "../../src/lib/state/onboard-session";
import { OnboardRuntime, type OnboardRuntimeDeps } from "../../src/lib/onboard/machine/runtime";

export {
  createSession,
  filterSafeUpdates,
  MACHINE_SNAPSHOT_VERSION,
} from "../../src/lib/state/onboard-session";
export type { Session, SessionUpdates } from "../../src/lib/state/onboard-session";

/**
 * In-memory onboarding-machine runtime for the machine test suites. The
 * fixture owns the session store mechanics the suites previously each
 * declared inline; scenario sessions, timestamps that assertions depend on,
 * and behavior expectations stay in each test. Every call returns fresh
 * state, and nothing outside the returned runtime is touched.
 */

/** A deep session copy that survives independent mutation. */
export function cloneSession(session: Session): Session {
  return normalizeSession(JSON.parse(JSON.stringify(session))) ?? session;
}

/** Behavior options for createTestRuntime. */
export interface TestRuntimeOptions {
  /** The deterministic clock the runtime stamps sessions with. */
  now?: () => string;
}

/**
 * An OnboardRuntime over an in-memory session store. Step transitions
 * mutate the stored session the way the suites' inline copies did; the
 * clock defaults to a fixed timestamp and is overridable where assertions
 * depend on a specific value.
 */
export function createTestRuntime(
  initialSession: Session = createSession(),
  options?: TestRuntimeOptions,
): OnboardRuntime {
  let session = cloneSession(initialSession);
  const updateSession = (mutator: (value: Session) => Session | void): Session => {
    session = cloneSession(mutator(cloneSession(session)) ?? session);
    return cloneSession(session);
  };
  const deps: OnboardRuntimeDeps = {
    loadSession: () => cloneSession(session),
    createSession,
    saveSession: (next) => {
      session = cloneSession(next);
      return cloneSession(session);
    },
    updateSession,
    markStepStarted: () => cloneSession(session),
    markStepComplete: (_stepName, updates: SessionUpdates = {}) =>
      updateSession((current) => {
        Object.assign(current, filterSafeUpdates(updates));
        return current;
      }),
    markStepSkipped: () => cloneSession(session),
    markStepFailed: (stepName, message) =>
      updateSession((current) => {
        current.steps[stepName].status = "failed";
        current.steps[stepName].error = message ?? null;
        return current;
      }),
    completeSession: (updates: SessionUpdates = {}) =>
      updateSession((current) => {
        Object.assign(current, filterSafeUpdates(updates));
        current.status = "complete";
        current.resumable = false;
        return current;
      }),
    filterSafeUpdates,
    emitEvent: () => undefined,
    now: options?.now ?? (() => "2026-05-28T00:00:00.000Z"),
  };
  return new OnboardRuntime(deps);
}

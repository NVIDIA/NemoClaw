// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Behavioral session tracker with trifecta detection.
 *
 * Tracks three capability classes per agent session: read_sensitive,
 * ingested_untrusted, and has_egress. When all three capabilities appear
 * in a single session (the "trifecta"), the risk level escalates to
 * critical, detecting multi-step exfiltration attacks that per-action
 * gates miss.
 */

// ── Public types ─────────────────────────────────────────────

/** The three capability classes tracked per session. */
export enum Capability {
  ReadSensitive = "read_sensitive",
  IngestedUntrusted = "ingested_untrusted",
  HasEgress = "has_egress",
}

/** Risk classification for a session. */
export type RiskLevel = "clean" | "elevated" | "critical";

/** A single capability event recorded against a session. */
export interface CapabilityEvent {
  readonly capability: Capability;
  readonly tool: string;
  readonly detail: string;
  readonly time: string;
}

/** Compact summary of a session for listing. */
export interface SessionSummary {
  readonly sessionId: string;
  readonly capabilities: Record<string, boolean>;
  readonly trifecta: boolean;
  readonly riskLevel: RiskLevel;
  readonly eventCount: number;
}

/** Detailed exposure data for a single session. */
export interface SessionExposure {
  readonly sessionId: string;
  readonly capabilities: Record<string, boolean>;
  readonly trifecta: boolean;
  readonly riskLevel: RiskLevel;
  readonly events: readonly CapabilityEvent[];
  readonly sensitiveFilesAccessed: readonly string[];
  readonly externalUrlsContacted: readonly string[];
  readonly egressAttempts: readonly string[];
}

// ── Constants ────────────────────────────────────────────────

const MAX_EVENTS_PER_SESSION = 100;

// ── Internal session state ───────────────────────────────────

interface Session {
  capabilities: Map<Capability, boolean>;
  events: CapabilityEvent[];
  updatedAt: string;
}

// ── Risk classification ──────────────────────────────────────

/** Check whether a capability map contains all three trifecta capabilities. */
function isTrifecta(caps: Map<Capability, boolean>): boolean {
  return (
    caps.get(Capability.ReadSensitive) === true &&
    caps.get(Capability.IngestedUntrusted) === true &&
    caps.get(Capability.HasEgress) === true
  );
}

function classifyRisk(caps: Map<Capability, boolean>, trifecta: boolean): RiskLevel {
  if (trifecta) {
    return "critical";
  }
  let count = 0;
  for (const v of caps.values()) {
    if (v) {
      count++;
    }
  }
  return count === 0 ? "clean" : "elevated";
}

// ── SessionStore class ───────────────────────────────────────

/**
 * In-memory store that tracks capability events per agent session.
 *
 * Node.js is single-threaded, so no mutex is needed (unlike the Go
 * implementation). Create one instance and share it across the
 * request-handling code.
 *
 * @param onTrifecta - Optional callback invoked once per session the first time
 *   all three capability classes are recorded. Use this to log a warning, emit a
 *   metric, or terminate the session. The callback receives the session ID.
 */
export class SessionStore {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly onTrifecta?: (sessionId: string) => void) {}

  /**
   * Record a capability event against a session.
   *
   * The method silently ignores empty `sessionId` values.
   * Once a session reaches {@link MAX_EVENTS_PER_SESSION} events,
   * additional events still update the capability set but are not
   * appended to the event log.
   * If all three capability classes are now present and the `onTrifecta`
   * callback was provided, it fires once for this session.
   */
  record(sessionId: string, cap: Capability, tool: string, detail: string): void {
    if (!sessionId) {
      return;
    }

    let sess = this.sessions.get(sessionId);
    if (!sess) {
      sess = {
        capabilities: new Map<Capability, boolean>(),
        events: [],
        updatedAt: "",
      };
      this.sessions.set(sessionId, sess);
    }

    const wasTrifecta = isTrifecta(sess.capabilities);
    sess.capabilities.set(cap, true);
    sess.updatedAt = new Date().toISOString();

    if (sess.events.length < MAX_EVENTS_PER_SESSION) {
      sess.events.push({
        capability: cap,
        tool,
        detail,
        time: sess.updatedAt,
      });
    }

    if (this.onTrifecta && !wasTrifecta && isTrifecta(sess.capabilities)) {
      this.onTrifecta(sessionId);
    }
  }

  /** Remove all sessions, releasing all tracked state. */
  clear(): void {
    this.sessions.clear();
  }

  /**
   * Return the capability map for a session, or `null` if the session
   * does not exist.
   */
  getCapabilities(sessionId: string): Record<string, boolean> | null {
    if (!sessionId) {
      return null;
    }
    const sess = this.sessions.get(sessionId);
    if (!sess) {
      return null;
    }
    const out: Record<string, boolean> = {};
    for (const [k, v] of sess.capabilities) {
      out[k] = v;
    }
    return out;
  }

  /**
   * Return `true` if the session has all three capability classes
   * (read_sensitive, ingested_untrusted, has_egress).
   */
  hasTrifecta(sessionId: string): boolean {
    if (!sessionId) {
      return false;
    }
    const sess = this.sessions.get(sessionId);
    if (!sess) {
      return false;
    }
    return isTrifecta(sess.capabilities);
  }

  /** Return summaries of all active sessions. */
  listSessions(): SessionSummary[] {
    const result: SessionSummary[] = [];
    for (const [id, sess] of this.sessions) {
      const capsCopy: Record<string, boolean> = {};
      for (const [k, v] of sess.capabilities) {
        capsCopy[k] = v;
      }
      const trifecta = isTrifecta(sess.capabilities);
      result.push({
        sessionId: id,
        capabilities: capsCopy,
        trifecta,
        riskLevel: classifyRisk(sess.capabilities, trifecta),
        eventCount: sess.events.length,
      });
    }
    return result;
  }

  /**
   * Return detailed exposure data for a session, or `null` if the
   * session does not exist.
   *
   * Sensitive files and external URLs are deduplicated by detail value.
   * Egress attempts are not deduplicated because each attempt is
   * independently significant.
   */
  getExposure(sessionId: string): SessionExposure | null {
    if (!sessionId) {
      return null;
    }
    const sess = this.sessions.get(sessionId);
    if (!sess) {
      return null;
    }

    const capsCopy: Record<string, boolean> = {};
    for (const [k, v] of sess.capabilities) {
      capsCopy[k] = v;
    }
    const trifecta = isTrifecta(sess.capabilities);

    // Deep-copy events to prevent external mutation of internal state.
    const eventsCopy: CapabilityEvent[] = sess.events.map((e) => ({ ...e }));

    const sensitiveFiles: string[] = [];
    const externalUrls: string[] = [];
    const egressAttempts: string[] = [];
    const seenFiles = new Set<string>();
    const seenUrls = new Set<string>();

    for (const evt of sess.events) {
      switch (evt.capability) {
        case Capability.ReadSensitive:
          if (evt.detail !== "" && !seenFiles.has(evt.detail)) {
            sensitiveFiles.push(evt.detail);
            seenFiles.add(evt.detail);
          }
          break;
        case Capability.IngestedUntrusted:
          if (evt.detail !== "" && !seenUrls.has(evt.detail)) {
            externalUrls.push(evt.detail);
            seenUrls.add(evt.detail);
          }
          break;
        case Capability.HasEgress: {
          let entry = evt.tool;
          if (evt.detail !== "") {
            entry += " " + evt.detail;
          }
          egressAttempts.push(entry);
          break;
        }
      }
    }

    return {
      sessionId,
      capabilities: capsCopy,
      trifecta,
      riskLevel: classifyRisk(sess.capabilities, trifecta),
      events: eventsCopy,
      sensitiveFilesAccessed: sensitiveFiles,
      externalUrlsContacted: externalUrls,
      egressAttempts,
    };
  }
}

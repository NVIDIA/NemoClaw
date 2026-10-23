// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// OpenClaw clamps even per-run timeout overrides to the Node timer maximum.
const MAX_TURN_TIMEOUT_MS = 2_147_483_647;
export const SEARCH_DENIAL_RETENTION_MS = MAX_TURN_TIMEOUT_MS + 60_000;
export const SEARCH_DENIAL_IDENTITY_LIMIT = 1024;

interface AdmittedSearchTurn {
  expiresAt: number;
  denied: boolean;
  aliases: Set<string>;
}

/** Reserve bounded turn ownership before inference so no active denial can overflow. */
export class DeniedSearchState {
  private readonly identities = new Map<string, AdmittedSearchTurn>();
  private capacityWarning = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  private readonly capacity: number;

  constructor(
    private readonly onCapacity: () => void,
    capacity = SEARCH_DENIAL_IDENTITY_LIMIT,
  ) {
    this.capacity = Math.max(1, Math.min(Math.floor(capacity), SEARCH_DENIAL_IDENTITY_LIMIT));
  }

  get size(): number {
    return this.identities.size;
  }

  admit(identity: string, aliases: readonly string[] = []): boolean {
    this.expire();
    const existing = this.owner(identity);
    if (existing) {
      this.rememberAliases(existing[1], aliases);
      return true;
    }
    if (this.knownAlias(identity)) return false;
    if (this.size >= this.capacity) {
      if (!this.capacityWarning) this.onCapacity();
      this.capacityWarning = true;
      return false;
    }
    const turn: AdmittedSearchTurn = {
      expiresAt: Date.now() + SEARCH_DENIAL_RETENTION_MS,
      denied: false,
      aliases: new Set([identity]),
    };
    this.rememberAliases(turn, aliases);
    this.identities.set(identity, turn);
    this.schedule();
    return true;
  }

  hasAdmission(identity: string | undefined, aliases: readonly string[] = []): boolean {
    this.expire();
    const found = identity ? this.owner(identity) : undefined;
    if (!found) return false;
    this.rememberAliases(found[1], aliases);
    return true;
  }

  deny(identity: string, aliases: readonly string[] = []): void {
    if (!this.admit(identity, aliases)) return;
    const turn = this.owner(identity)?.[1];
    if (!turn) return;
    turn.denied = true;
    turn.expiresAt = Date.now() + SEARCH_DENIAL_RETENTION_MS;
    this.schedule();
  }

  blocks(identity: string | undefined): boolean {
    this.expire();
    this.schedule();
    if (!identity) return true;
    const found = this.owner(identity);
    return found ? found[1].denied : this.knownAlias(identity);
  }

  delete(identity: string | readonly string[]): void {
    const aliases = typeof identity === "string" ? [identity] : identity;
    const run = aliases.find((key) => key.startsWith("runId:"));
    const exact = run ? this.owner(run) : undefined;
    if (exact) {
      this.identities.delete(exact[0]);
    } else {
      // A different known run must never be released through a shared session.
      const matches = [...this.identities].filter(
        ([, turn]) =>
          aliases.some((key) => turn.aliases.has(key)) &&
          (!run || ![...turn.aliases].some((key) => key.startsWith("runId:"))),
      );
      if (matches.length === 1) this.identities.delete(matches[0]![0]);
    }
    this.schedule();
  }

  private owner(identity: string): [string, AdmittedSearchTurn] | undefined {
    const matches = [...this.identities].filter(([, turn]) => turn.aliases.has(identity));
    return matches.length === 1 ? matches[0] : undefined;
  }

  private knownAlias(identity: string): boolean {
    return [...this.identities.values()].some((turn) => turn.aliases.has(identity));
  }

  private rememberAliases(turn: AdmittedSearchTurn, aliases: readonly string[]): void {
    const fields = new Set([...turn.aliases].map((key) => key.split(":")[0]));
    for (const alias of aliases.slice(0, 3)) {
      const field = alias.split(":")[0];
      if (!fields.has(field) && turn.aliases.size < 3) {
        turn.aliases.add(alias);
        fields.add(field);
      }
    }
  }

  clear(): void {
    this.identities.clear();
    this.capacityWarning = false;
    this.schedule();
  }

  private expire(): void {
    const now = Date.now();
    for (const [identity, { expiresAt }] of this.identities) {
      if (expiresAt <= now) this.identities.delete(identity);
    }
    if (this.size < this.capacity) this.capacityWarning = false;
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const nextExpiry = Math.min(
      ...Array.from(this.identities.values(), ({ expiresAt }) => expiresAt),
    );
    if (!Number.isFinite(nextExpiry)) return;
    // Retention includes cleanup grace beyond Node's largest timer delay.
    const delay = Math.min(MAX_TURN_TIMEOUT_MS, Math.max(1, nextExpiry - Date.now()));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.expire();
      this.schedule();
    }, delay);
    this.timer.unref();
  }
}

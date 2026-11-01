// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// OpenClaw clamps even per-run timeout overrides to the Node timer maximum.
const MAX_TURN_TIMEOUT_MS = 2_147_483_647;
export const SEARCH_DENIAL_RETENTION_MS = MAX_TURN_TIMEOUT_MS + 60_000;
export const SEARCH_DENIAL_IDENTITY_LIMIT = 1024;

export interface SuppliedSearchSources {
  local: boolean;
  urls: readonly string[];
}

type RetrievalSource = { kind: "local" } | { kind: "url"; url: string };

function canonicalRetrievalUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (!/^https?:$/u.test(url.protocol) || url.username || url.password) return undefined;
    // A fragment selects a position within the same retrieved document.
    url.hash = "";
    return url.href;
  } catch {
    return undefined;
  }
}

interface DeniedSearchTurn {
  expiresAt: number;
  denied: boolean;
  sources: SuppliedSearchSources | undefined;
  aliases: Set<string>;
}

/** Reserve bounded active-turn ownership before inference; completion releases it. */
export class DeniedSearchState {
  private readonly identities = new Map<string, DeniedSearchTurn>();
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

  canAdmit(identity: string, aliases: readonly string[] = []): boolean {
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
    return true;
  }

  admit(
    identity: string,
    aliases: readonly string[] = [],
    suppliedSources?: SuppliedSearchSources,
  ): boolean {
    if (!this.canAdmit(identity, aliases)) return false;
    const sources = suppliedSources && {
      local: suppliedSources.local,
      urls: suppliedSources.urls
        .map(canonicalRetrievalUrl)
        .filter((url): url is string => url !== undefined),
    };
    const existing = this.owner(identity);
    if (existing) {
      existing[1].sources = sources;
    } else {
      const turn: DeniedSearchTurn = {
        expiresAt: Date.now() + SEARCH_DENIAL_RETENTION_MS,
        denied: false,
        sources,
        aliases: new Set([identity]),
      };
      this.rememberAliases(turn, aliases);
      this.identities.set(identity, turn);
      this.schedule();
    }
    return true;
  }

  deny(identity: string, aliases: readonly string[] = []): void {
    this.expire();
    const turn = this.owner(identity)?.[1];
    if (!turn) {
      this.schedule();
      return;
    }
    this.rememberAliases(turn, aliases);
    turn.denied = true;
    turn.expiresAt = Date.now() + SEARCH_DENIAL_RETENTION_MS;
    this.schedule();
  }

  blocks(
    identity: string | undefined,
    aliases: readonly string[] = [],
    source?: RetrievalSource,
  ): boolean {
    this.expire();
    this.schedule();
    if (!identity) return true;
    const found = this.owner(identity);
    if (found) {
      this.rememberAliases(found[1], aliases);
      const turn = found[1];
      if (!turn.denied) return false;
      if (turn.sources?.local && source?.kind === "local") return false;
      if (turn.sources && source?.kind === "url") {
        const url = canonicalRetrievalUrl(source.url);
        return url === undefined || !turn.sources.urls.includes(url);
      }
      return true;
    }
    // An over-capacity turn never acquired ownership. It cannot gain substitute
    // access when another turn completes; admission must reserve that ownership.
    return true;
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

  private owner(identity: string): [string, DeniedSearchTurn] | undefined {
    const matches = [...this.identities].filter(([, turn]) => turn.aliases.has(identity));
    return matches.length === 1 ? matches[0] : undefined;
  }

  private knownAlias(identity: string): boolean {
    return [...this.identities.values()].some((turn) => turn.aliases.has(identity));
  }

  private rememberAliases(turn: DeniedSearchTurn, aliases: readonly string[]): void {
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

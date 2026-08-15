// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

type RefreshCredentialState = {
  sandbox?: unknown;
  refresh_token_sha256?: unknown;
};

type RefreshCredentialEntry = Readonly<{
  refreshToken: string;
}>;

type HashCredential = (credential: string) => string;
type RestoreRefreshCredential = () => boolean;

/**
 * Process-memory-only refresh credentials for the shared Hermes tool broker.
 *
 * Durable state carries only hashes. Each sandbox identity owns one in-memory
 * value, so adding or removing a clone cannot replace another sandbox's
 * credential even when every sandbox shares the same broker listener.
 */
class RuntimeRefreshCredentialStore {
  private readonly hashCredential: HashCredential;
  private readonly credentials = new Map<string, RefreshCredentialEntry>();

  constructor(hashCredential: HashCredential) {
    this.hashCredential = hashCredential;
  }

  register(state: RefreshCredentialState | null | undefined, refreshToken: unknown): boolean {
    const sandbox = String(state?.sandbox || "").trim();
    const expectedHash = String(state?.refresh_token_sha256 || "").trim();
    const normalized = String(refreshToken || "").trim();
    if (!sandbox || !expectedHash || !normalized) return false;
    if (this.hashCredential(normalized) !== expectedHash) return false;
    // Keep a distinct entry for every successful write. Rollback callbacks
    // compare the entry identity so a later write of the same token still wins.
    this.credentials.set(sandbox, { refreshToken: normalized });
    return true;
  }

  resolve(state: RefreshCredentialState | null | undefined): string | null {
    const sandbox = String(state?.sandbox || "").trim();
    const expectedHash = String(state?.refresh_token_sha256 || "").trim();
    const entry = this.credentials.get(sandbox);
    if (!sandbox || !expectedHash || !entry) return null;
    if (this.hashCredential(entry.refreshToken) !== expectedHash) {
      this.credentials.delete(sandbox);
      return null;
    }
    return entry.refreshToken;
  }

  rotate(state: RefreshCredentialState | null | undefined, nextRefreshToken: unknown): boolean {
    return this.register(state, nextRefreshToken);
  }

  replace(
    state: RefreshCredentialState | null | undefined,
    nextRefreshToken: unknown,
  ): RestoreRefreshCredential | null {
    const sandbox = String(state?.sandbox || "").trim();
    if (!sandbox) return null;
    const previous = this.credentials.get(sandbox);
    if (!this.register(state, nextRefreshToken)) return null;
    const replacement = this.credentials.get(sandbox)!;
    let pending = true;
    return () => {
      if (!pending) return false;
      pending = false;
      if (this.credentials.get(sandbox) !== replacement) return false;
      if (previous !== undefined) this.credentials.set(sandbox, previous);
      else this.credentials.delete(sandbox);
      return true;
    };
  }

  unregister(sandboxName: unknown): boolean {
    const sandbox = String(sandboxName || "").trim();
    return sandbox ? this.credentials.delete(sandbox) : false;
  }
}

module.exports = { RuntimeRefreshCredentialStore };

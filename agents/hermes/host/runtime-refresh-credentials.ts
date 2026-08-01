// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Process-memory-only refresh credentials for the shared Hermes tool broker.
 *
 * Durable state carries only hashes. Each sandbox identity owns one in-memory
 * value, so adding or removing a clone cannot replace another sandbox's
 * credential even when every sandbox shares the same broker listener.
 */
class RuntimeRefreshCredentialStore {
  constructor(hashCredential) {
    this.hashCredential = hashCredential;
    this.credentials = new Map();
  }

  register(state, refreshToken) {
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

  resolve(state) {
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

  rotate(state, nextRefreshToken) {
    return this.register(state, nextRefreshToken);
  }

  replace(state, nextRefreshToken) {
    const sandbox = String(state?.sandbox || "").trim();
    if (!sandbox) return null;
    const hadPrevious = this.credentials.has(sandbox);
    const previous = this.credentials.get(sandbox);
    if (!this.register(state, nextRefreshToken)) return null;
    const replacement = this.credentials.get(sandbox);
    let pending = true;
    return () => {
      if (!pending) return false;
      pending = false;
      if (this.credentials.get(sandbox) !== replacement) return false;
      if (hadPrevious) this.credentials.set(sandbox, previous);
      else this.credentials.delete(sandbox);
      return true;
    };
  }

  unregister(sandboxName) {
    const sandbox = String(sandboxName || "").trim();
    return sandbox ? this.credentials.delete(sandbox) : false;
  }
}

module.exports = { RuntimeRefreshCredentialStore };

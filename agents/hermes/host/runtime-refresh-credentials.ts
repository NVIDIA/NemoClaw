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
    this.credentials.set(sandbox, normalized);
    return true;
  }

  resolve(state) {
    const sandbox = String(state?.sandbox || "").trim();
    const expectedHash = String(state?.refresh_token_sha256 || "").trim();
    const refreshToken = this.credentials.get(sandbox);
    if (!sandbox || !expectedHash || !refreshToken) return null;
    if (this.hashCredential(refreshToken) !== expectedHash) {
      this.credentials.delete(sandbox);
      return null;
    }
    return refreshToken;
  }

  rotate(state, nextRefreshToken) {
    return this.register(state, nextRefreshToken);
  }

  unregister(sandboxName) {
    const sandbox = String(sandboxName || "").trim();
    return sandbox ? this.credentials.delete(sandbox) : false;
  }
}

module.exports = { RuntimeRefreshCredentialStore };

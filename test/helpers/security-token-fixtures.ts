// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export function makeJwtFixture(): string {
  return ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "signatureABCDEFGHI"].join(".");
}

export function makeEmptyClaimsJwtFixture(): string {
  return ["eyJhbGciOiJIUzI1NiJ9", "e30", "signatureABCDEFGHI"].join(".");
}

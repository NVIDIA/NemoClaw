// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const privateEntrySecret = `nvapi-${"A".repeat(64)}`;

export async function main() {
  throw new Error(`api_key=${privateEntrySecret}\u001b[31m\u202e\n${"x".repeat(5_000)}`);
}

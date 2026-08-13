<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# anti-slop Upstream Source

This directory vendors the rule sources from `dmmulroy/anti-slop` commit `9b80d9a5c317d3af94d88a577bdbde4d9a45f7be`.

The vendored TypeScript files differ from that commit only by added SPDX headers and one behavior change: `rules/no-conditional-empty-object-spread.ts` unwraps parentheses around each conditional branch before checking for an empty object.
The upstream MIT terms are in [LICENSE](LICENSE).

<!--
SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: Apache-2.0
-->

# Code reduction

Determine whether the change delivers its required outcome with the least code and smallest supported surface that fits the repository.

A good code reduction review owns concrete deletion and consolidation proposals. It considers the change and the surrounding implementation as one end state, then identifies exact code, branches, helpers, fixtures, tests, compatibility paths, and documentation that can disappear. It accounts for the complete source-and-test result rather than moving the same structure behind another name.

Report a finding when an identified deletion or consolidation produces a smaller coherent implementation with the same required behavior. Name the exact code to remove or merge, the behavior and trust-boundary guarantees that remain, and the resulting reduction in owners, concepts, branches, files, or lines.

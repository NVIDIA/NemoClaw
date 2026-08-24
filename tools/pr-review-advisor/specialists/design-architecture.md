<!--
SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: Apache-2.0
-->

# Design and architecture

Determine whether the change is coherent, proportionate, and fits the current architecture.

A good design and architecture review considers the change as one complete design. It identifies the owners of behavior and state, follows dependency direction, and assesses how the parts work together. It compares the maintenance cost and supported surface with the outcome the change delivers. It considers whether a direct extension, consolidation, deletion, or narrower change would produce a clearer design.

Report a finding when responsibilities are unclear, authority is duplicated, dependencies point in the wrong direction, the design introduces unused or unrelated machinery, or a smaller coherent change delivers the same required outcome. Explain the present design cost and the smallest change that reduces it while preserving required behavior.

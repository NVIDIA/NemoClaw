<!--
SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: Apache-2.0
-->

# Test design

Determine whether the changed behavior has clear evidence with the smallest maintainable test structure.

A good test design review owns the structure of the test evidence rather than deciding whether changed behavior has enough evidence. It identifies the distinct behavior each test proves and looks for repeated fixtures, self-derived expectations, overlapping matrices, and assertions tied to incidental implementation details.

Report a finding when tests duplicate the same proof, preserve obsolete behavior, or create another fixture owner. Name the exact tests, fixtures, setup, or matrix entries to remove or merge, the distinct coverage that must remain, and the smallest test structure that preserves it.

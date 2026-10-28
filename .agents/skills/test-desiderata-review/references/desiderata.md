<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Test Desiderata

Kent Beck's [Test Desiderata](https://medium.com/@kentbeck_7670/test-desiderata-94150638a4b3) ([revisited in 2022](https://newsletter.kentbeck.com/p/desirable-unit-tests)) are tradeoffs: give one up only for a benefit worth its cost.
The questions are this skill's interpretation.

| Property | Question |
|---|---|
| Behavioral | Would a plausible wrong output, state change, or error fail the test? Does the expected value have an independent source? |
| Structure-insensitive | Would a behavior-preserving refactor leave it passing? Look for pinned call order, private access, and broad snapshots, unless they protect an external protocol. |
| Specific | Would a failure point to its cause? |
| Readable | Can a reader see the setup, action, and expected outcome in domain terms, and does the name match what is asserted? |
| Writable | Is the setup cheap relative to what the test protects? |
| Fast | Is it fast enough for its purpose? Measure instead of guessing from size. |
| Isolated | Does the result depend on test order, or on shared files, ports, clocks, or environment? |
| Composable | Does it pass alone and in any group, without relying on suite-wide setup? |
| Deterministic | Do unchanged conditions give unchanged results? Watch time, randomness, races, and live services; sleeps and retries hide them. |
| Automated | Does it run without human steps? |
| Inspiring | Does passing give developers confidence to keep changing the code? |
| Predictive | Does passing say something about production, such as real boundaries, persistence, and recovery, or do substitutes assume the answer? |

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Telemetry Schemas

`nemoclaw-telemetry.schema.json` owns the strict local telemetry contract.
The client and dashboard use this contract and their channel-uniqueness checks.
Do not upload it to Schema Management Service (SMS).

`nemoclaw-telemetry-sms.schema.json` is the generated SMS registration file.
It preserves all event names, field names, types, required fields, scalar encodings, and privacy metadata.
It is not an independent contract and must not replace local validation.

Generate or check the registration file from the repository root:

```bash
node scripts/telemetry/generate-sms-schema.mts
node scripts/telemetry/generate-sms-schema.mts --check
```

The generator uses direct closed objects and string enums.
String constants become singleton enums. Reachable numeric constants become equal minimum and maximum bounds.
Every object field remains required. Unknown schema keywords stop generation.
Finite string alternatives become a field enum only when every alternative supplies a bound.
This preserves the public configuration values without retaining conditional signal/value rules in SMS.

SMS cannot express all local rules. The registration file omits combinations, conditionals, `not`, and array uniqueness.
The client and dashboard still reject invalid field combinations, invalid calendar dates, IP addresses, coordinates, and duplicate channels.
The SMS file keeps existing direct patterns and bounds, but these do not enforce every omitted rule.

The generator follows the documented SMS restrictions. Actual service acceptance remains unverified until a portal import succeeds.
The existing empty-string encoding for unavailable location fields remains unchanged.
Schema `2.1` added a required string `testLabel` to every event.
Ordinary records use an empty string; QA records use the bounded campaign, case, and attempt label.
Schema `2.2` adds the public Hub model ID `nvidia/nvidia/nemotron-3-ultra` with key `nemotron3_ultra`.
This category remains separate from `nvidia/nemotron-3-ultra-550b-a55b`; the Hub ID does not establish a model size.
Unrecognized model IDs remain `other` with status `unapproved`. Missing model state remains `unknown` with status `not_observed`.
The schema definition version remains `2.0`.
The fixed UAT selector requires a valid QA label. Consent values and Production activation do not change.

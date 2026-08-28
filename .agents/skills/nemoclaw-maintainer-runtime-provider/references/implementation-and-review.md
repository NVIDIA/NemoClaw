<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Implementation and Review

Use this reference to plan provider work, review a provider PR, and select focused validation.

## Provider-Neutral Architecture

The configuration and registration boundary may map a requested provider name to one bundle.
Provider implementations may inspect their own engine IDs and endpoint authority.

Generic onboarding, gateway, lifecycle, state, action, and cleanup modules must not:

- import Docker, Podman, Kubernetes, MXC, or another provider implementation;
- compare a provider, engine, or driver identity with a provider-name literal;
- use an environment switch to select provider behavior after bundle resolution; or
- require a new provider-name branch when another provider is registered.

When a generic module lacks required behavior, extend the smallest provider-owned surface. Add an
architecture guard for the affected central module. Do not weaken an existing boundary check or
add a provider exception.

Keep portable experimental modules and their compatibility code independent. Native Podman and the
portable profile are different product paths.

## Implementation Sequence

1. Confirm accepted scope, topology, platforms, agents, workload type, lifecycle authority, and
   qualification matrix.
2. Define the opaque provider ID, endpoint authority, resource handle, and persistent state.
3. Implement the complete bundle shape with explicit unsupported candidate surfaces.
4. Implement host inspection, lifecycle preflight, and provider-owned gateway requirements.
5. Implement immutable workload receipt acceptance.
6. Implement bootstrap, start, started-state verification, stop, and privileged control.
7. Implement inference service authority and credential redaction where applicable.
8. Implement fenced state mutation, snapshot, restore, and restart recovery.
9. Implement side-effect-free cleanup planning, authority revalidation, removal, and absence
   confirmation.
10. Persist the provider identity and prove each later operation resolves the same bundle.
11. Add registry, provider, architecture, negative-authority, recovery, and cleanup tests.
12. Add the activation registration only after protected qualification satisfies the declaration.
13. Run the complete supported runtime-qualified E2E matrix against the commit under review.

## Focused Validation

Discover the current commands from `AGENTS.md`, `package.json`, and Vitest projects. The current
focused set normally includes:

```bash
npm run typecheck:cli
npm run checks:repository
npx vitest run --project cli \
  src/lib/onboard/runtime-provider/runtime-provider-contract.test.ts \
  src/lib/onboard/runtime-provider/activation.test.ts \
  src/lib/onboard/runtime-provider/<provider>.test.ts
npx vitest run --project integration test/repository/layer-import-boundaries.test.ts
npx vitest run --project e2e-support test/e2e/support/native-runtime-qualification.test.ts
```

Replace `<provider>` with the provider test file. Add focused lifecycle, inference, mutation,
snapshot, recovery, and cleanup tests when those surfaces change. Run broader gates only when the
diff meets the repository criteria for them.

These checks do not establish protected qualification. Use the trusted GitHub Actions workflow and
the complete supported E2E matrix for the commit under review.

## Failure and Security Coverage

Test at least these provider-bound failures when applicable:

- missing, malformed, unknown, reused, or drifted provider identity;
- endpoint or socket authority drift between operation scopes;
- runtime handle, lifecycle generation, or ownership mismatch;
- timeout, nonzero status, partial publication, and controller restart;
- state-mutation rollback and active-fence recovery;
- snapshot source and target provider mismatch;
- cleanup with missing, shared, ambiguous, or changed ownership;
- credential redaction from logs, receipts, and artifacts; and
- resource absence after successful cleanup.

For each credential, record its location, access, lifetime, transfer boundary, redaction, rotation,
and removal behavior.

## Review Checklist

A provider PR is not approval-ready until the review can answer each question:

- Does accepted product scope exist?
- Does one opaque provider ID bind every surface and persisted record?
- Does the provider own its commands, endpoint authority, and resource identity?
- Can another provider register without a new provider-name branch in generic orchestration?
- Are portable profile behavior and compatibility unchanged?
- Do unsupported candidate surfaces state reasons?
- Does activation enter through the qualification-backed composition seam?
- Does protected evidence bind the candidate, base, workflow, job, attempt, and artifact?
- Do state mutation, recovery, and cleanup fail closed on authority drift?
- Do focused checks pass for the commit under review?
- Does the complete supported E2E matrix pass for that same commit?
- Are ownership, compatibility, security, and upgrade obligations documented?

Classify failures as provider-integration regressions, infrastructure failures, unsupported jobs,
or flakes. Do not change product behavior to hide infrastructure or unsupported-job failures.

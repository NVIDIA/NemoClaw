<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Hermes upgrade contract map

Use this map to distinguish active release selectors, published image selectors, semantic contracts, and historical evidence.
Search for the outgoing tag and semver after reviewing these known surfaces.

## Active release identity

The updater owns five active identity pins:

| Selector | File | Meaning |
|---|---|---|
| `HERMES_VERSION` | `agents/hermes/Dockerfile.base` | Authoritative GitHub CalVer tag. |
| `HERMES_SEMVER` | `agents/hermes/Dockerfile.base` | Package version from target `pyproject.toml`. |
| `HERMES_TARBALL_SHA256` | `agents/hermes/Dockerfile.base` | GitHub source archive SHA-256. |
| `HERMES_NPM_INTEGRITY` | `agents/hermes/Dockerfile.base` | npm registry cross-check for the matching semver. |
| `expected_version` | `agents/hermes/manifest.yaml` | Installed CLI semver contract. |

`agents/hermes/Dockerfile` has a separate active selector:
`BASE_IMAGE` must name the branch-published Hermes base image by immutable multi-platform digest.
That digest is an output of the source-pin commit, not an input to the first edit.

The npm `hermes-agent` package is a bridge published from a different repository.
Use its signed registry metadata as a cross-check.
Do not treat it as the authoritative Hermes source release.

The generic release-ledger collector parses strict three-component SemVer.
Use the Hermes supplement named in the skill to reconcile the GitHub stable-release list and preserve numeric CalVer endpoints such as `v2026.7.7.2`.
The complete Hermes range is the union of the generic evidence and every adjacent pair in the supplement.

## Generated configuration

Audit these surfaces:

- `agents/hermes/config/hermes-config.ts`;
- `test/generate-hermes-config.test.ts`;
- config generation and `hermes doctor --fix` order in `agents/hermes/Dockerfile`;
- upstream `DEFAULT_CONFIG`, migrations, validation, and config-loading precedence.

Update `_config_version` to the target schema.
Inspect every new migration and changed default even when NemoClaw does not emit that key.
Pin a prior security or authorization default explicitly when the dependency upgrade must preserve it.
In particular, compare browser page-context evaluation policy and other tool-specific permission
defaults; Hermes 0.19 changed `browser.restrict_evaluate` from an implicit denylist to an opt-in
denylist while NemoClaw exposes the browser toolset.
Also compare gateway session-reset and retention defaults plus reasoning-display defaults; those
affect durability or privacy even though they are not credential settings.
Inspect newly visible model-output channels and self-update behavior, including automatic backups
or secondary downloads; a version bump must not silently duplicate state, expose a channel, or
fetch a mutable update payload.
Trace profile creation and every alternate `HERMES_HOME`.
Hermes named profiles can intentionally omit `config.yaml`, so a generated default-home pin does
not protect them.
When policy must cover every profile, bind the pinned upstream default source and every independent
config copy, raw-YAML fallback, or gateway loader to exact hashes, keep generated
default/dashboard configs explicit as defense in depth, and build-probe a real freshly created
config-less named profile through the classic CLI, TUI, agent-output, browser, update-command, and
gateway paths, including config-load error fallbacks.

The dashboard uses a separate sandbox-owned `HERMES_HOME`, and NemoClaw mirrors an allowlist from
the gateway config at startup.
Treat that compatibility bridge as a fail-safe policy migration: a missing source can be a benign
cold-start no-op, while an existing malformed, non-mapping, unreadable, routing-free source or
invalid destination must preserve destination bytes and abort dashboard startup.
Do not print PyYAML exception text because parser context can include API-key source lines.

The Dockerfile runs upstream config repair before it writes the final NemoClaw config.
A stale generated schema can therefore survive the build and migrate only at runtime.

## Compatibility workarounds

Audit each workaround against target source and its removal condition:

| Contract | NemoClaw surface |
|---|---|
| Resumed one-shot session append | `agents/hermes/hermes-cli-adapter-v1.json`, `agents/hermes/hermes-wrapper.py`, and `test/hermes-wrapper-oneshot-routing.test.ts`. |
| Provider plus model proxy routing | `agents/hermes/hermes-cli-adapter-v1.json`, `agents/hermes/hermes-wrapper.py`, and `test/hermes-wrapper-provider-merge.test.ts`. |
| Latest session-list preview | `agents/hermes/patch-session-list-preview.py` and the Dockerfile smoke test. |
| Config-less profile policy defaults | `agents/hermes/patch-profile-policy-defaults.py`, `test/hermes-profile-policy-defaults.test.ts`, and the final-image named-profile probe. |
| Writable managed gateway runtime metadata | `agents/hermes/patch-gateway-runtime-metadata.py`, `test/hermes-gateway-runtime-metadata-patch.test.ts`, and the final-image source-shape, integrity, and path probes. Preserve Hermes' process-scoped home selector while relocating central default-gateway PID, lock, and status helpers. Search the full pinned tree for explicit metadata paths before claiming broader support; patch and runtime-test each supported direct consumer or document inherited `--replace`, marker, profile/multiplexer, service/boot, and packaging residuals. |
| Writable cron execution history | `agents/hermes/patch-cron-execution-runtime.py`, `test/hermes-cron-execution-runtime-patch.test.ts`, the manifest path, and the final-image cross-identity probe. Keep cron job definitions inside the high-risk `cron` directory, relocate only the mutable SQLite audit ledger below `runtime`, and patch the upstream quick snapshot inventory in the same guarded patch operation. |
| OpenShell Langfuse placeholders | `agents/hermes/patch-langfuse-credentials.mts` and its Dockerfile source-shape probe. |
| Managed light-terminal skin | `src/lib/domain/sandbox/connect-env.ts` and `test/hermes-light-skin-boundary.test.ts`. |
| Config output masking and gateway secret boundary | `agents/hermes/hermes-wrapper.py`, validator scripts, and live secret-boundary tests. |

Review the top-level and `chat` parser metadata in the target source.
Update `hermes-cli-adapter-v1.json` only for a managed translation form.
Do not add an upstream subcommand to the adapter.
`validate-cli-adapter.py` compares the contract with Hermes' machine-readable parser metadata.
The wrapper reads session-name command boundaries from the installed upstream coalescer source.
Do not copy that boundary set into the adapter or wrapper.
The top-level and `chat` help probes are runtime evidence and are not the compatibility authority.

Hermes 0.19 defines `-c/--continue` with an optional session value.
The bare flag selects the most recent session.
The adapter owns the resumed one-shot forms that require translation, including unquoted multi-word
session names before the one-shot option.
Test bare, quoted, and unquoted forms plus global profile selectors.
Provider and model composition accepts a session name as one argument.
The `provider_model_composition` key names this managed translation, not the
`NEMOCLAW_PROVIDER_MODEL` environment value.
The adapter rejects an unquoted multi-word session plus provider and model flags before Hermes
runs because a later positional can be an upstream command. Quote the session name to make it one
argument.
Test that a new unrelated command passes through without an adapter change.
The wrapper must verify the upstream CLI version before it invokes a translated command.
The final Dockerfile intentionally rejects a new semver while version-bound workarounds remain unreviewed.

Retarget a patch comment only after confirming that its exact upstream source shape remains applicable.
Refresh every committed integrity hash after changing protected helper bytes.

## Durable state

Audit upstream backup code, state paths, SQLite connection modes, cleanup, and the uid/gid and file mode used by each state creator and consumer.
Relevant NemoClaw surfaces include:

- `agents/hermes/manifest.yaml`;
- `src/lib/state/sandbox.ts`;
- rebuild, snapshot, restore, and stale-directory tests;
- live rebuild and messaging recovery targets.

Use `state_dirs` for directory trees.
Use `state_files` with `sqlite_backup` for live SQLite databases.
When a SQLite database also lives under a state directory, the online state-file backup and restore must run after directory transfer so the consistent copy wins.
Test nested state-file paths, missing parent recreation, WAL and SHM cleanup, and rebuild persistence.
A `mode=ro` SQLite connection to a WAL-mode source can still materialize `-wal` and `-shm`
sidecars owned by the backup identity. Remove those stale sidecars after atomically installing the
restored database and before the producer reopens it; otherwise group-readable but non-writable
sidecars can make the replacement appear read-only to the producer.
When a gateway-created ledger is backed up or restored by the sandbox identity, verify every such
parent's owner, shared group, and setgid mode. Record the real producer-selected database mode:
the live source must be group-readable for online backup, while the sandbox-owned restored
replacement must be group-writable so the gateway can reopen it. Prove both identities' behavior
instead of assuming every SQLite creator uses mode `0660`.
Do not assume a state directory inherited the shared contract because a neighboring ledger did.
Hermes 0.19 creates cron execution history and
`gateway/discord_message_recovery.db` from gateway-owned processes, while sandbox performs the
snapshot restore.
NemoClaw keeps cron job definitions in the high-risk `cron` directory and removes group write
access during Shields up.
NemoClaw relocates only the execution ledger to `runtime/cron-executions.db`.
Making the whole `cron` directory cross-identity writable would let the `sandbox` group modify
cron job definitions.
Use distinct-user image or runtime probes; a single-uid temporary-directory test cannot prove this contract.
Resolve whether each ledger follows `get_hermes_home()` or the default root.
Hermes named profiles relocate profile-local state below `profiles/<name>/`; a static default-profile `state_files` entry does not online-back up those copies.
Inventory default and named-profile paths separately, and record any named-profile database left inside a raw `state_dirs` tar capture.
Adding dynamic profile-local SQLite discovery changes the generic snapshot security boundary and requires its own path-validation, backup, restore, and adversarial tests.

Do not add a whole runtime directory when one durable ledger is the contract.
Avoid capturing incidental sockets, locks, caches, or credentials.

## Packaging and dependencies

Audit target `pyproject.toml`, `uv.lock`, package manifests, and every selected extra from `HERMES_UV_EXTRAS`.
Diff the complete installed dependency closure.
Review:

- Python and Node runtime floors;
- exact hashes and source indexes;
- advisories and downstream overrides;
- licenses, notices, and SBOM coverage;
- native build requirements and removed build tools;
- messaging bridge npm locks and lifecycle scripts;
- `python-multipart`, because the base image has a hash-verified FastAPI upload-parser backstop.

Do not assume an upstream lock pin is acceptable because it is unchanged.
Re-review explicit NemoClaw backstops on every Hermes upgrade.

## Runtime surfaces

Use source and live evidence for:

- MCP server naming and progressive disclosure;
- gateway health, auth, delivery, and restart;
- Slack, Discord, Telegram, WhatsApp, and other enabled messaging extras;
- OpenShell inference routing and provider placeholders;
- environment-secret rejection and masked config output;
- session resume, export, and preview;
- persisted state across snapshot and rebuild.

Bind runtime evidence to the PR SHA and the final pinned image digest.

## Build-system contract

The final Hermes Dockerfile invokes the checked-in `image-build-probes.py` runner for source,
wrapper, state, and cross-identity assertions.
Build it with BuildKit/buildx for canonical validation, and require every probe-runner command to
execute.
When a change affects gateway-builder compatibility, run a separate legacy-builder build and
require its log to show the same commands executing successfully.
Do not treat that compatibility result as a replacement for the BuildKit image proof.

## Historical selectors

Do not update a version reference only because it matches the outgoing active version.
Preserve identities in:

- old-base rebuild fixtures;
- version-parser and comparison examples;
- historical dependency reviews and changelogs;
- compatibility history and migration tests;
- installed-copy updater fixtures.

Classify each match as active, compatibility, test fixture, documentation, or historical evidence before editing it.

## Publication sequence

Use this order:

1. Implement the exact source pin and semantic migrations.
2. Run focused checks and a local base plus final image build.
3. Commit and push the source state.
4. Verify no unrelated base-image run is queued or active, because a new dispatch uses global cancel-in-progress concurrency.
5. Dispatch the base-image workflow with the branch ref and require the selected run's `headSha` to equal the source commit.
6. Verify the Hermes multi-platform publication.
7. Pin the published digest in the final Dockerfile.
8. Rebuild and inspect the final image.
9. Push the digest commit.
10. Run CI, review, and E2E on the head commit.

Repeat steps 3 through 9 when a base-image input changes.

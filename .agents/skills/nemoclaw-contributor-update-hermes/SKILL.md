---
name: nemoclaw-contributor-update-hermes
description: Audit, implement, and validate Hermes Agent upgrades in NVIDIA/NemoClaw. Use when changing the pinned Hermes CalVer tag or semver, reviewing a Hermes release, rebuilding the Hermes sandbox base image, or checking Hermes-specific configuration, wrapper, patch, state, packaging, and runtime contracts. Trigger keywords - update Hermes, upgrade Hermes, Hermes release, Hermes Agent version, Hermes base image, Hermes dependency review.
---

# Update Hermes

Treat a Hermes upgrade as a semantic migration and an image publication.
Use the generic dependency-upgrade workflow for the full upstream audit.
Apply the Hermes-specific contract checks in this skill before the PR is approval-ready.

## Mutation boundary

Change only the NVIDIA/NemoClaw checkout in scope.
Treat the Hermes repository, releases, package registries, and producer workflows as read-only.
Do not update installer-managed copies or rebuild a local sandbox without explicit authorization for those host-visible changes.

## Start with the generic audit

Read and follow
[`nemoclaw-contributor-update-dependencies`](../nemoclaw-contributor-update-dependencies/SKILL.md).
Add its dependency-upgrade checklist to the working plan.
Then read [the Hermes contract map](references/hermes-contract-map.md).

Do not replace the generic release ledger, concern ledger, dependency audit, or artifact audit with this skill.
This skill adds Hermes release-identity and downstream-contract requirements.

## Resolve the exact target

1. Read the current active selectors from the contract map.
2. Query the authoritative `NousResearch/hermes-agent` GitHub releases.
3. Select a published, non-draft, non-prerelease release.
4. Resolve its annotated tag object, peeled commit, release record, producer runs, source archive SHA-256, and package semver.
5. Verify the Python package artifacts and treat the npm package as a registry cross-check only.
6. Record every adjacent release between the current tag and the target.
7. Reconcile the GitHub release list with `pyproject.toml` versions.

Hermes uses CalVer release tags and semver package versions.
A four-component CalVer tag such as `v2026.7.7.2` can be absent from a three-component semantic-tag collector.
Do not omit such a release from the adjacent-range audit.

Run the generic collector for its full evidence model, then reconcile its endpoint list with the authoritative stable Hermes releases.
Capture the paginated release API before reading upstream content:

```bash
<reviewed-absolute-gh> api --hostname github.com --method GET --paginate --slurp \
  "repos/NousResearch/hermes-agent/releases?per_page=100" \
  > <temporary-releases.json>

<reviewed-absolute-gh> api --hostname github.com --method GET --paginate --slurp \
  "repos/NousResearch/hermes-agent/git/matching-refs/tags/v?per_page=100" \
  > <temporary-tag-refs.json>
```

When the helper is already present byte-for-byte on trusted `origin/main`, copy
`.agents/skills/nemoclaw-contributor-update-hermes/scripts/collect-hermes-release-supplement.py`
from that commit into a mode-0700 private temporary file.
Use the generic collector's trusted-blob procedure and run the supplement against the same complete
upstream clone, frozen Git executable, and frozen GitHub snapshots:

```bash
<reviewed-absolute-python> <trusted-temporary-hermes-supplement.py> \
  --repo <upstream-worktree> \
  --from <current-tag> \
  --to <target-tag> \
  --releases-json <temporary-releases.json> \
  --remote-tag-refs-json <temporary-tag-refs.json> \
  --git-executable <reviewed-absolute-git> \
  --output <temporary-hermes-supplement.json>
```

The supplement accepts numeric CalVer tags with three or more components.
It rejects missing or duplicate stable release records, a missing authoritative tag ref,
lightweight release tags, a local annotated tag object that differs from the authoritative GitHub
tag-ref root, non-linear ancestry, and an absent endpoint.
Treat its ordered `releaseEndpoints` as the authoritative stable Hermes range.
Compare that list with the generic ledger, add every omitted endpoint and adjacent range to the concern ledger, and record both evidence files.
Do not call the release ledger complete until the first and last endpoints match and every consecutive supplement pair has a reviewed range.

### Bootstrap a new or changed supplement helper

An upgrade branch that introduces or changes this helper cannot use its own mutable helper bytes as
provenance evidence.
Capture the authoritative release and matching-tag-ref snapshots with the frozen, reviewed `gh`
path, run the trusted generic collector, and use the frozen, reviewed Git path to inspect any
four-component CalVer endpoints it omits.
For each omitted endpoint, directly record the local annotated tag-object SHA, peeled commit SHA,
its equality with the frozen GitHub tag-ref root, ancestry, and adjacent commit and changed-path
inventories.

Record the proposed helper's SHA-256 and forward-test it against those frozen snapshots, including
a negative test that recreates a local annotated tag and requires remote-root mismatch rejection.
That forward test validates the proposed code; it is not provenance evidence for the upgrade.
The helper becomes eligible for the trusted-blob procedure only after it is merged into the trusted
`origin/main`.

Requery the authoritative release list immediately before the planned landing.
If a newer stable release exists, audit the added range before changing the target.
Do not silently replace the reviewed target.

## Audit Hermes contracts

For each adjacent release, inspect release notes, commits, changed paths, source, upstream tests, packaging, and producer workflows.
Map each material change through these NemoClaw surfaces:

- generated config schema, defaults, migrations, approval behavior, and config-less named-profile fallbacks;
- isolated-home config mirrors, parse failures, stale policy, and secret-safe error reporting;
- wrapper flags, subcommands, argument translation, and help probes;
- session preview, Langfuse, and managed light-skin workarounds;
- durable SQLite ledgers, state directories, backups, rebuilds, and rollback;
- Python extras, the complete `uv.lock` closure, npm bridge packages, licenses, notices, advisories, and native builds;
- MCP naming, progressive tool disclosure, messaging bridges, inference routing, and environment-secret boundaries.

Inventory every downstream workaround.
Remove one only when target source and runtime evidence satisfy its recorded removal condition.
Retarget comments, exact-source guards, integrity hashes, and regression tests for every retained workaround.
When a workaround relocates a runtime path helper, search the entire pinned source tree for literal
path joins, marker helpers, profile and multiplexer readers, service and boot adapters, and
packaging scripts. Either retarget and runtime-test every supported consumer or narrow the
supported managed path and record the remaining direct-CLI consumers as inherited residuals.
A helper-level image probe does not prove that every explicit path consumer agrees.

Record silent default changes as migration concerns.
Do not inherit an authorization, network, credential, or persistence default through a version-only bump.
Treat every gateway-to-dashboard or alternate-home config mirror as a policy boundary.
Missing source config may be a cold-start no-op, but an existing malformed, non-mapping,
unreadable, or routing-free source and an invalid destination must fail startup without changing
the destination.
Never log raw YAML parser exceptions; they can include credential-bearing source lines.

## Implement the source pin

Pass the reviewed tag explicitly:

```bash
scripts/update-hermes-agent.sh --tag <exact-tag>
```

Do not use the script with its moving default for the final PR.
Do not pass `--update-installed-copies` in an ordinary checkout-only PR.
Do not pass `--rebuild` without explicit authorization.
That flag implies `--update-installed-copies` and can modify `~/.nemoclaw`, `~/.hermes`, and `NEMOCLAW_SOURCE_ROOT`.

Update semantic contracts before accepting the new active selectors.
Preserve historical fixtures, release reviews, and old-base rebuild evidence unless their purpose is the active selector.

Run the updater again with the same exact tag after edits.
Require a no-diff result for all identity pins.
Include `test/update-hermes-agent-script.test.ts` and
`test/sandbox-provisioning.test.ts` plus `test/sandbox-rlimit-hooks.test.ts` in the focused upgrade
suite.
Move the updater test's active target and fake package-version contract to the new release, while
preserving older installed-copy and unsafe-candidate fixtures as historical migration coverage.

## Validate the image layers

Build the Hermes base image without cache after the source migration:

```bash
scripts/update-hermes-agent.sh --tag <exact-tag> --build
```

Use an explicit Docker endpoint when the host runtime requires one.
Do not use a local moving tag as PR or release evidence.

Run concern-specific unit and integration tests.
Build the final Hermes image against the locally built base.
Require the Dockerfile source-shape guards, wrapper help probes, patch smoke tests, generated-config checks, dependency audit, and installed-version checks to pass.

Use BuildKit for the final image build.
`agents/hermes/Dockerfile` invokes the checked-in `image-build-probes.py` runner for source and
cross-identity runtime probes so the supported OpenShell gateway builder executes the same
assertions without Dockerfile heredoc support.
Keep BuildKit as the canonical final-image validation path.
A separate legacy-builder build can prove gateway compatibility only when its log shows every
expected probe-runner command executing successfully; it does not replace the BuildKit result.
Prefer the same buildx path used by repository workflows:

```bash
docker buildx build --load \
  --build-arg BASE_IMAGE=<local-or-immutable-reviewed-base> \
  -f agents/hermes/Dockerfile \
  -t <temporary-final-image> .
```

Confirm the output reports each expected probe-runner command as an executed BuildKit step.
If `docker buildx` is not registered as a Docker CLI plugin, invoke the reviewed buildx executable
directly rather than falling back to the legacy builder.

Exercise live paths for changes to persistence, messaging, MCP, credentials, inference, restart, or rebuild behavior.
Treat a successful image build as build evidence, not runtime evidence.

## Publish and pin the branch base image

Commit and push the source-pin and compatibility changes before publication.
Before dispatch, query live `base-image.yaml` runs and wait or coordinate if any run is queued or in progress.
That workflow uses a repository-wide `base-image` concurrency group with `cancel-in-progress: true`, so a new Hermes dispatch can cancel an unrelated OpenClaw or Deep Agents publication.
Do not cancel or supersede another maintainer's run.

Dispatch `.github/workflows/base-image.yaml` with the pushed branch ref.
Resolve the resulting run and require its `headSha` to equal the intended source-pin commit before using any artifact or tag.
Verify that the Hermes job succeeds and publishes both `linux/amd64` and `linux/arm64`.

Resolve the immutable multi-platform digest for the branch SHA tag.
Update the final `agents/hermes/Dockerfile` `BASE_IMAGE` selector to that digest.
Do not pin a digest from another SHA, tag, workflow attempt, or repository.

If any base-image input changes after publication, publish again and replace the digest.
Build and inspect the final image from the pinned digest before using it as runtime proof.

## Complete the PR

Use
[`nemoclaw-contributor-create-pr`](../nemoclaw-contributor-create-pr/SKILL.md)
for the commit, PR template, labels, CI, review, and exact-head follow-up.
State the target tag and semver, adjacent release ranges, material migrations, retained workarounds, dependency disposition, base-image digest, local evidence, and remaining live gates.

Keep Friday or another planned landing date separate from merge authorization.
Make the PR approval-ready for that date, but do not merge before the requested window.

## Completion conditions

The upgrade is approval-ready only when:

- the target is still the selected stable release;
- every active selector names the same reviewed release;
- all release-range concerns have a disposition and verification;
- retained workarounds pass against target source and runtime;
- the branch base-image workflow succeeds for the source SHA;
- the final Dockerfile pins that branch image by immutable multi-platform digest;
- exact-head CI, automated review, and required E2E pass; and
- the PR has no unresolved blocking review thread or material external gate.

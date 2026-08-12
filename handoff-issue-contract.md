<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Issue #8614 closure contract

## Reporter workflow

Source: [issue body](https://github.com/NVIDIA/NemoClaw/issues/8614) and [reporter follow-up](https://github.com/NVIDIA/NemoClaw/issues/8614#issuecomment-5224815419).

Environment reported by `zxman0126`: NemoClaw v0.0.102, Hermes Agent 0.19.0 sandbox, and DGX Spark GB10.

1. Run `config set memory.provider`; observe an immediate gateway SIGTERM and restart.
2. Run `config set model.supports_vision`; observe no immediate restart and a restart note.
3. Write `platforms.teams.home_channel.chat_id` before its required `platform` field.
4. Trigger a restart with another config write; observe `HomeChannel.from_dict` fail and the gateway enter relaunch quarantine after five exits.
5. Rebuild the sandbox and run `config set` before `recover`; observe a compat-hash failure that a later `recover` does not repair.
6. Rebuild again, run `recover`, and then run `config set`; observe the write succeed.
7. Inspect `/tmp/gateway.log`, `~/.hermes/logs/agent.log`, and the integrity-frozen `.env`; observe that the useful traceback and managed `.env` writes are not disclosed by the host command.
8. Set `security.allow_private_urls` to `true`, then set `browser.cdp_url` to `http://10.200.0.1:9223`; observe CLI rejection before Hermes receives the value.

The required local reproduction uses the built worktree `./bin/nemoclaw.js`, Hermes sandbox `triage-8614`, and ports unique to this issue.

## Expected behavior

- NemoClaw validates a complete Hermes candidate configuration before persistence.
- NemoClaw rejects an incomplete structural write with the missing field or path.
- Rejection leaves the configuration file, managed `.env`, integrity hashes, gateway state, and quarantine state unchanged.
- A valid complete structural write succeeds.
- A successful rebuild leaves Hermes configuration writable. If the security model requires recovery, NemoClaw rejects the write before mutation and prints the exact recovery command; recovery then succeeds without another rebuild.
- Hermes config output truthfully states possible or observed gateway restart effects and readiness or recovery state.
- A failed Hermes restart reports a bounded, sanitized tail from `/tmp/gateway.log`.
- Config output discloses managed `.env` effects without exposing values or secrets.
- Private URLs remain rejected by default.
- An explicit `security.allow_private_urls: true` opt-in permits the private `browser.cdp_url` through CLI validation and the Hermes plugin runtime override.
- The accepted private URL works through the complete supported sandbox path.
- A user can recover from config-driven relaunch failure without an additional rebuild when the preserved valid configuration permits recovery.

## Observed behavior

- Hermes candidate writes receive integrity and MCP checks but not complete Hermes structural validation.
- An incomplete `home_channel` object persists and fails during Hermes boot.
- Repeated gateway exits quarantine relaunch until sandbox recreation.
- Rebuild can leave frozen-input compatibility hashes stale until gateway recovery refreshes them.
- The first post-rebuild config write can fail after partial reconciliation, and later recovery can remain insufficient.
- Restart effects differ by key and command output does not explain the effect accurately.
- The actionable boot traceback remains only in the in-container `/tmp/gateway.log`.
- Managed `TEAMS_HOME_CHANNEL*` `.env` updates are not disclosed.
- CLI URL validation rejects private hosts without reading the explicit Hermes opt-in.
- The Hermes plugin forces `_allow_private_urls_resolved` to false, which defeats the runtime opt-in even if CLI validation permits the URL.

## Acceptance paths and sources

Sources:

- [Issue body](https://github.com/NVIDIA/NemoClaw/issues/8614): restart behavior, structural-write quarantine, rebuild and recovery ordering, diagnostics, managed `.env` effects, and expected recovery behavior.
- [Reporter follow-up](https://github.com/NVIDIA/NemoClaw/issues/8614#issuecomment-5224815419): private URL default rejection and explicit opt-in.
- `issue-8614.md`: current-code analysis and the coordinated closing scope.
- GitHub timeline and `closedByPullRequestsReferences`, fetched before implementation: no linked pull request or review exists; the only cross-reference is another issue.

Acceptance paths:

1. Incomplete `platforms.teams.home_channel` write: reject before persistence; preserve files and hashes; do not restart or quarantine Hermes.
2. Complete `platforms.teams.home_channel` write: persist the valid candidate and report managed `.env` effects.
3. Rebuild integrity lifecycle: a direct subsequent config write succeeds, or a pre-mutation gate prints the exact `recover` command and the write succeeds after one recovery without another rebuild.
4. Restart disclosure: output does not promise that Hermes remains running when the write can restart it; output reports readiness or the required recovery action.
5. Restart failure: output includes useful, bounded, sanitized gateway diagnostics and excludes representative secrets.
6. Private URL default: reject `browser.cdp_url` on a private host when the opt-in is absent or false.
7. Private URL opt-in: accept the same URL only after explicit opt-in, preserve validation for unrelated URL risks, and pass the setting through the Hermes plugin runtime.
8. Quarantine recovery: preserve or restore a valid configuration and provide a non-rebuild recovery path when the sandbox can recover safely.

## Explicit non-goals

- Do not weaken private-host rejection by default.
- Do not add an unrestricted global SSRF bypass.
- Do not duplicate the Hermes schema in NemoClaw when the bundled Hermes parser or schema can validate a candidate without side effects.
- Do not expose configuration values, credentials, tokens, or an unbounded gateway log.
- Do not claim an exact upstream restart-key matrix unless the implementation owns and verifies that matrix.
- Do not change OpenClaw configuration behavior unless a shared owner requires the same correction.
- Do not add Hermes behavior unrelated to this config lifecycle.
- Do not use a rebuild as the normal repair for a rejected candidate configuration.
- Do not open a partial PR or use `Relates to #8614` if any closure item remains unimplemented or unvalidated.

## Required validation evidence

Before the fix, capture the reporter failure with the built worktree `./bin/nemoclaw.js` on `yimoj-colossus-dev` after dependency installation, CLI and plugin builds, and worktree OpenShell installation. Supporting helpers, direct imports, fixtures, unit tests, and raw `openshell` commands do not replace this evidence.

After the fix, capture real worktree CLI transcripts for Hermes sandbox `triage-8614` with unique ports:

- incomplete `home_channel` write rejected with no persistence, hash change, restart, or quarantine;
- valid complete `home_channel` write accepted;
- rebuild followed by config set succeeds, or exact pre-gate recovery ordering succeeds without another rebuild;
- forced restart failure reports a bounded sanitized diagnostic tail;
- private `browser.cdp_url` rejected by default;
- the same private URL accepted end to end only after explicit opt-in;
- managed `.env` and restart effects disclosed without secret values.

Automated evidence must include focused tests for candidate structural validation, atomic unchanged files and hashes, rebuild postconditions, recovery ordering, bounded log length, log redaction, managed `.env` disclosure, private URL default rejection, explicit CLI opt-in, and Hermes plugin runtime opt-in. Run targeted builds and tests, the repository pre-commit gate, independent Codex review, the signed commit and post-commit gate, and the pre-push gate including `npm test`.

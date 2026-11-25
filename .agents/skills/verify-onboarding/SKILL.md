---
name: verify-onboarding
description: Verify, as a new user, that the `nemoclaw onboard` terminal UI turns answers into a saved deployment YAML and that `nemoclaw plan` on that file intends the gateway, sandbox, harness, image, model, and provider the answers chose. Drives the TUI through hc when available, otherwise tmux. Stops at plan; never applies. Use after changing onboarding, authoring, discovery, templates, or the plan output, before claiming an onboarding journey works.
disable-model-invocation: true
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Verify Onboarding

This skill drives `nemoclaw onboard` in a terminal the way a new user does, saves the YAML, and runs `nemoclaw plan` on it.
A journey passes when the saved YAML holds the answers and the plan intends the matching resources.
It never applies: whether the plan creates working resources belongs to the [verify-yaml-deployment](../verify-yaml-deployment/SKILL.md) skill and the [live tests](../../../internal-docs/contributing/live-tests.md), which stay the gate.
When a journey must hold on every change, add a test at the layer the `write-tests` skill picks; the TUI's own unit tests live in [`tui/tests.rs`](../../../crates/nemoclaw-onboarding/src/tui/tests.rs).

## Scope

- **Surface:** `nemoclaw onboard [TEMPLATE] --output FILE` from a verified native bundle, then `nemoclaw plan FILE`.
  The standalone `nemoclaw-onboarding` example skips target discovery; it needs its own journeys.
- **Target:** a Docker engine on this host, which onboarding and plan read without changing.
  Plan creates nothing on the engine; each journey checks that no resource carries its UID.
- **Credentials:** none.
  Onboarding runs with the template's credential variables unset, and plan gets the placeholder value `verify-placeholder`, so no real key reaches a model catalog or the state directory.
  Ask the user before a run that uses a real key, for example to check discovered model suggestions.

A journey takes seconds; building the bundle takes a few minutes, and the [express journey](features/express-review.md) may first need a local agent image.

## Launch

Run every command from the repository root, in one shell; the variables and functions carry between steps.
The commands work in zsh and bash.

### Choose This Run's Identity

```sh
RUN=$(date -u +%Y%m%d-%H%M%S)
RUN_DIR=$HOME/nemoclaw-verify/onboarding/$RUN
EVIDENCE=$RUN_DIR/evidence
mkdir -p "$EVIDENCE"
git rev-parse HEAD > "$EVIDENCE/revision.txt"
```

Onboarding writes a fresh `metadata.uid` into each saved YAML; that UID is the journey's identity, and the journey directory is the only state directory that UID ever gets.

### Build the Bundle

```sh
cargo ci bundle
PLATFORM=$(ls dist)
BUNDLE=$RUN_DIR/bundle
cp -a "dist/$PLATFORM" "$BUNDLE"
shasum -a 256 "$BUNDLE/bin/nemoclaw" > "$EVIDENCE/bundle.sha256"
"$BUNDLE/bin/nemoclaw" --version > "$EVIDENCE/version.txt"
```

`ls dist` must print one platform; remove stale platform directories first.
The copy keeps a later `cargo ci bundle` from changing the CLI mid-run.

### Choose the Terminal Driver

```sh
if command -v hc >/dev/null 2>&1 && hc ls >/dev/null 2>&1; then DRIVER=hc
elif command -v tmux >/dev/null 2>&1; then DRIVER=tmux
else echo 'install tmux or hc'; fi
echo "$DRIVER" > "$EVIDENCE/driver.txt"
```

Define the journey and driver functions.
Each journey gets its own directory, evidence directory, and terminal named after the run:

```sh
journey() {
  J=$1; JDIR=$RUN_DIR/$J; JEV=$EVIDENCE/$J; TUI=onb-$RUN-$J
  mkdir -p "$JDIR" "$JEV"
}
# Type a line at the shell prompt, as a user would. The leading space keeps it out of
# history in shells that ignore space-prefixed lines.
tui_type() {
  case $DRIVER in
    hc) hc send "$TUI" " $1" > /dev/null ;;
    tmux) tmux send-keys -t "$TUI" -l " $1"; tmux send-keys -t "$TUI" Enter ;;
  esac
}
# Open your interactive shell in this journey's terminal, then type `nemoclaw onboard`.
# $1 is the template ("" for none). The shell prints onboard-exit=N when onboarding ends.
tui_start() {
  case $DRIVER in
    hc) hc get "$TUI" > /dev/null 2>&1 ;;
    tmux) tmux has-session -t "$TUI" 2> /dev/null ;;
  esac
  if [ $? -ne 0 ]; then
    case $DRIVER in
      hc) hc run --bg --no-notify --name "$TUI" --cwd "$JDIR" > /dev/null ;;
      tmux) tmux new-session -d -s "$TUI" -x 200 -y 80 -c "$JDIR" ;;
    esac
    # printf keeps each marker out of the typed line, so a wait matches only the output.
    tui_type "printf 'shell-%s\\n' ready"; tui_wait shell-ready 30 || return 1
  fi
  cmd="env -u NVIDIA_API_KEY"
  template=""
  if [ -n "$1" ]; then
    for v in $(sed -n 's/^ *env: *//p' "$1" | sort -u); do cmd="$cmd -u $v"; done
    template="'$1'"
  fi
  cmd="clear; $cmd '$BUNDLE/bin/nemoclaw' onboard $template --output '$JDIR/deployment.yaml'; printf 'onboard-%s=%s\\n' exit \$?"
  echo "$cmd" > "$JEV/command.txt"
  tui_type "$cmd"
}
tui_screen() {
  case $DRIVER in
    hc) hc read "$TUI" --lines 0 ;;
    tmux) tmux capture-pane -p -t "$TUI" ;;
  esac | sed 's/[[:space:]]*$//' | grep -v '^$' | grep -v '[█╚╝⠁]'
}
# Wait up to $2 seconds (default 20) for text on the screen; print the screen on timeout.
tui_wait() {
  n=0
  until tui_screen | grep -qF -- "$1"; do
    n=$((n + 1))
    if [ "$n" -ge $(( ${2:-20} * 2 )) ]; then echo "timeout waiting for: $1"; tui_screen | tail -20; return 1; fi
    sleep 0.5
  done
}
# Press keys by name: enter esc tab up down left backspace ctrl+a ctrl+d ctrl+o ctrl+c.
tui_keys() {
  for k in "$@"; do
    case $DRIVER in
      hc) hc keys "$TUI" "$k" > /dev/null ;;
      tmux)
        case $k in
          enter) k=Enter ;; esc) k=Escape ;; tab) k=Tab ;; up) k=Up ;; down) k=Down ;; left) k=Left ;;
          backspace) k=BSpace ;; ctrl+?) k=C-${k#ctrl+} ;;
        esac
        tmux send-keys -t "$TUI" "$k" ;;
    esac
    sleep 0.3
  done
}
# Replace the current text answer and submit it.
tui_answer() {
  tui_keys ctrl+a
  case $DRIVER in
    hc) hc send "$TUI" "$1" > /dev/null ;;
    tmux) tmux send-keys -t "$TUI" -l "$1"; tmux send-keys -t "$TUI" Enter ;;
  esac
  sleep 0.5
}
# Move the selection to the choice labeled $1.
tui_choose() {
  for dir in up down; do
    n=0
    while [ "$n" -lt 15 ]; do
      tui_screen | grep -qF "●  $1" && return 0
      tui_keys "$dir"; n=$((n + 1))
    done
  done
  echo "no choice labeled: $1"; return 1
}
snap() { tui_screen > "$JEV/$1.txt"; }
tui_stop() {
  case $DRIVER in
    hc) hc kill "$TUI" > /dev/null 2>&1; hc rm "$TUI" > /dev/null 2>&1 ;;
    tmux) tmux kill-session -t "$TUI" 2> /dev/null ;;
  esac
}
saved_uid() { sed -n 's/^  uid: //p' "$JDIR/deployment.yaml"; }
owned() {
  [ -z "$1" ] && { echo 0; return; }
  l="label=nemoclaw.nvidia.com/uid=$1"
  { docker container ls -aq --filter "$l"; docker volume ls -q --filter "$l"; docker network ls -q --filter "$l"; } | wc -l | tr -d ' '
}
```

`tui_stop` acts only on the terminal this journey named; it never stops processes or containers by name.
`tui_start` opens your login shell and types the command into it, so onboarding sees the environment a user's terminal has, minus the credential variables it unsets on purpose.
A second `tui_start` in the same journey reuses the open shell.
The typed lines assume a POSIX-style shell such as zsh or bash; they start with a space, which keeps them out of history only where the shell ignores space-prefixed lines (`setopt histignorespace` in zsh, `HISTCONTROL=ignorespace` in bash).

Launch one journey:

```sh
journey express
tui_start "$JDIR/template.yaml"
tui_wait 'Press Enter to begin.' && snap 01-welcome
```

Ready means the welcome screen shows `Press Enter to begin.`; a screen that says `Resize to continue.` means the terminal is too small.

## Plan and Read the Intent

After a journey saves its YAML, plan it twice: as text, which the user reads, and as JSON, which scripts read.
Then read the saved plan that `nemoclaw apply` would carry out, with the bundle's OpenTofu, and reduce it to the fields an onboarding answer controls:

```sh
placeholders() { sed -n 's/^ *env: *//p' "$1" | sort -u | sed 's/$/=verify-placeholder/'; }
plan_intent() {
  cp "$JDIR/deployment.yaml" "$JEV/deployment.yaml"
  env $(placeholders "$JDIR/deployment.yaml") "$BUNDLE/bin/nemoclaw" plan "$JDIR/deployment.yaml" \
    --state-dir "$JDIR/state" --non-interactive --progress off > "$JEV/plan.txt" 2>&1
  echo "plan-exit=$?"
  env $(placeholders "$JDIR/deployment.yaml") "$BUNDLE/bin/nemoclaw" plan "$JDIR/deployment.yaml" \
    --state-dir "$JDIR/state" --non-interactive --progress off -o json > "$JEV/plan.json" 2> "$JEV/plan.err"
  TF_CLI_CONFIG_FILE="$JDIR/state/providers.tfrc" "$BUNDLE/libexec/tofu" -chdir="$JDIR/state" \
    show -json apply.plan > "$JEV/plan-show.json"
  jq '{
    actions: ([.resource_changes[] | select(.mode == "managed") | .change.actions[]] | unique),
    owners: ([.resource_changes[] | .change.after.owner? // empty] | unique),
    gateway: (.resource_changes[] | select(.type == "openshell_gateway_storage") | .change.after | {compute_driver, engine, network_cidr}),
    sandboxes: [.resource_changes[] | select(.type == "openshell_sandbox") | .change.after | {name, image}],
    agents: [.resource_changes[] | select(.address | startswith("terraform_data.agent_")) | .change.after.input | fromjson
      | {harness: .harness.adapter_id, agent: .metadata.name, models: ([.models[].model] | unique)}],
    inference: [.resource_changes[] | select(.type == "openshell_inference") | .change.after
      | {api, endpoint: .server.endpoint, credential_env: .server.credential_env}]
  }' "$JEV/plan-show.json" > "$JEV/intent.json"
  cat "$JEV/intent.json"
}
```

A plan of a new deployment shows `Plan incomplete` with `complete: false`: the gateway and the image's Fabric metadata are observed only when apply starts them.
That is expected here; the journey fails on a nonzero `plan-exit`, an `outcome` other than `planned`, or an intent that does not match the answers.
`intent.json` reads an internal artifact whose shape belongs to the compiler; when its fields move, fix the `jq` filter, not the expectation.

## Doctor

Read-only; run it before the first keypress of each journey, after any surprise, and before planning:

```sh
shasum -a 256 -c "$EVIDENCE/bundle.sha256"
docker info --format 'engine {{.ServerVersion}} {{.OperatingSystem}}'
case $DRIVER in
  hc) hc get "$TUI" --json 2>/dev/null | jq -r '.cwd' ;;
  tmux) tmux display-message -p -t "$TUI" '#{pane_current_path}' 2>/dev/null ;;
esac | grep -cxF "$JDIR" || true
[ -e "$JDIR/deployment.yaml" ] && echo "uid $(saved_uid) owned=$(owned "$(saved_uid)")"
[ -e "$JDIR/state/intent.json" ] && jq -e --arg uid "$(saved_uid)" '.document.metadata.uid == $uid' "$JDIR/state/intent.json"
```

Pass when the bundle checksum is `OK`, the engine answers, any open terminal's working directory is this journey's directory (`1`), any saved YAML's UID owns `0` engine resources, and any state directory's intent names that UID (`true`).
Never type into, plan with, or destroy anything another run or person created.

## Drive

Follow the [feature map](features/README.md).
Run one journey at a time: each waits on its own screen, and two onboarding sessions reading the engine at once make discovery timing harder to read.

## Evidence

Each journey writes under `$EVIDENCE/<journey>/`, outside the checkout and the state directory, so it survives cleanup:

- numbered screen captures from `snap`, one per step a feature names;
- `command.txt`, the onboarding command line;
- `deployment.yaml`, the saved file;
- `plan.txt`, `plan.json`, `plan.err`, `plan-show.json`, and `intent.json` from `plan_intent`;
- `destroy.txt` from cleanup.

Never write a real credential into evidence; the journeys never have one.
Before handing off, check that the placeholder reached no file that plan writes, and that nothing resembling a key did:

```sh
grep -rl verify-placeholder "$EVIDENCE" | wc -l
grep -rl -E '(TOKEN|KEY)=[^ ]{16,}|nvapi-[A-Za-z0-9_-]{20,}' "$EVIDENCE" | wc -l
```

Both counts must be 0.

## Cleanup

Run this for each journey, including failed ones:

```sh
tui_stop
if [ -d "$JDIR/state" ]; then
  "$BUNDLE/bin/nemoclaw" destroy --state-dir "$JDIR/state" --progress off > "$JEV/destroy.txt" 2>&1
  grep -c 'Nothing to remove.' "$JEV/destroy.txt"
fi
[ -e "$JDIR/deployment.yaml" ] && owned "$(saved_uid)"
```

Destroy must print `Nothing to remove.` (count `1`) and the owned count must be `0`: plan created nothing.
Anything else means a plan reached the engine; stop, keep the state directory, and report it.
After the last journey's cleanup, remove this run's working files, keeping the evidence:

```sh
for d in "$RUN_DIR"/*/; do [ "$d" = "$EVIDENCE/" ] || rm -rf "$d"; done
ls "$EVIDENCE"
```

Remove nothing outside `$RUN_DIR`; leave agent images in place, since other runs and deployments use them.

## Report

State the revision, driver, and each journey's result with its evidence files, including any review `Image` status that varied from the feature file.
A journey proven with one driver, template, or engine does not cover another.

## Hand Off

Keep the map current with the [maintain-verification-skill](../maintain-verification-skill/SKILL.md) skill.

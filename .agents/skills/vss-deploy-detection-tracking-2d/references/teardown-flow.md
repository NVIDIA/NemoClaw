# Teardown Flow

Detailed workflow for stopping a running RTVI-CV deployment. Follow the 5 steps in order. Create the teardown task list first, then work through each step, updating todos as you go.

## Step T0 — Create the Teardown Task List

```json
{
  "merge": false,
  "todos": [
    {"id": "t_discover", "content": "Discover running RTVI-CV containers (docker ps | grep rtvi)", "status": "in_progress"},
    {"id": "t_select",   "content": "Select which container(s) to stop",                           "status": "pending"},
    {"id": "t_method",   "content": "Choose stop method (graceful stop / force kill / dry-run)",    "status": "pending"},
    {"id": "t_cleanup",  "content": "Choose cleanup scope (just container / + engine cache / + NGC resources)", "status": "pending"},
    {"id": "t_execute",  "content": "Execute teardown and verify container stopped",                "status": "pending"}
  ]
}
```

## Step T1 — Discover Running Containers

**Print:** `Looking for running RTVI-CV containers...`

```bash
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}' | grep -iE 'perception|vss-rt-cv|rtvi' || echo "NONE"
```

If output is `NONE`:

> No running RTVI-CV containers found. Is the deployment already stopped?

Offer: (a) list ALL containers (`docker ps -a`) to double-check, (b) exit.

Otherwise, present the matched containers as a small table and proceed to T2.

## Step T2 — Select Which Container to Stop

If multiple match, use `AskQuestion` with one option per container plus an "all" option:

```json
{
  "questions": [
    {
      "id": "target",
      "prompt": "Which container(s) to stop?",
      "options": [
        {"id": "rtvicv-perception-docker", "label": "rtvicv-perception-docker — <image> — <status>"},
        {"id": "all",                       "label": "All RTVI-CV containers listed above"}
      ]
    }
  ]
}
```

Single-container case: skip `AskQuestion` and confirm `Will stop: <name>.`

## Step T3 — Choose Stop Method

```json
{
  "questions": [
    {
      "id": "stop_method",
      "prompt": "How should the container be stopped?",
      "options": [
        {"id": "graceful", "label": "Graceful stop (docker stop) — sends SIGTERM, waits 10s, then SIGKILL. Recommended."},
        {"id": "force",    "label": "Force kill (docker kill) — immediate SIGKILL, no graceful shutdown"},
        {"id": "dryrun",   "label": "Just show me the command, don't run it"}
      ]
    }
  ]
}
```

## Step T4 — Choose Cleanup Scope

**Defaults are conservative — never delete user data unless explicitly chosen.**

```json
{
  "questions": [
    {
      "id": "cleanup",
      "prompt": "What else to clean up? (Careful — rebuilding engines takes 3-10 min, re-downloading NGC resources is 10+ GB)",
      "options": [
        {"id": "container_only", "label": "Just the container (recommended — --rm auto-removes it)"},
        {"id": "engines",        "label": "Container + engine cache (/opt/storage/engines/) — next deploy will rebuild engines"},
        {"id": "full",           "label": "Container + engines + NGC resources (/opt/storage/resources/) — full wipe, next deploy will re-download everything"}
      ]
    }
  ]
}
```

> **Never** auto-delete `~/.ngc/config` — NGC credentials are reused for future runs. Only suggest removing it if the user is rotating API keys.

## Step T5 — Execute Teardown

**Print:** `Stopping <CONTAINER_NAME> via <method>...`

Stop command by method:

```bash
# Graceful (recommended)
docker stop <CONTAINER_NAME>

# Force
docker kill <CONTAINER_NAME>

# Dry-run — just print the command, do not execute
echo "docker stop <CONTAINER_NAME>"
```

Cleanup beyond the container:

> Storage under `~/rtvicv-storage/` may be root-owned (the container runs as
> `--user root`), so removal needs `sudo`. An agent cannot type a password, so
> detect sudo capability first and capture it in `$SUDO` — on a host where
> `sudo` needs a password this hands off cleanly instead of hanging:
>
> ```bash
> # NOTE: no docker-group/rootless branch here (unlike platforms.md) — being in
> # the docker group lets you run containers without sudo but does NOT grant
> # permission to delete root-owned files under ~/rtvicv-storage/. Do not add a
> # `docker info` branch back: it would mask the real need for elevated rm.
> if sudo -n true 2>/dev/null; then SUDO="sudo"            # passwordless → proceed
> elif [ "$(id -u)" -eq 0 ]; then SUDO=""                  # already root
> else
>     echo "✖ sudo needs a password and the agent cannot enter it." >&2
>     echo "  Run this once, then re-run teardown: sudo -v" >&2
>     exit 1
> fi
> ```

```bash
# engines option — clear just the cached TRT engines
$SUDO rm -rf $HOME/rtvicv-storage/engines/
echo "Cleared engine cache — next deploy will rebuild (3-10 min per model)."

# full option — CONFIRM TWICE with the user before running this (10+ GB re-download next time)
$SUDO rm -rf $HOME/rtvicv-storage/engines/
$SUDO rm -rf $HOME/rtvicv-storage/resources/
echo "Cleared engine cache and NGC resources — next deploy will re-download everything."
```

**Verify the container is gone:**

```bash
docker ps --filter "name=<CONTAINER_NAME>" --format '{{.Names}}' | grep -q . \
  && echo "STILL RUNNING" || echo "STOPPED"
```

**Print on success:**

> Teardown complete.
> - Container `<NAME>` stopped ✓
> - Cache preserved at `~/rtvicv-storage/` (engines + NGC resources) — reused on next deploy
> - NGC credentials preserved at `~/.ngc/config`

## Offer Next Action

```json
{
  "questions": [
    {
      "id": "next_after_teardown",
      "prompt": "Teardown done. What next?",
      "options": [
        {"id": "redeploy", "label": "Redeploy — start a fresh RTVI-CV with a different use case or config"},
        {"id": "logs",     "label": "Show the container's final logs (if captured)"},
        {"id": "done",     "label": "Nothing else, thanks"}
      ]
    }
  ]
}
```

If redeploy: jump back to the top of the DEPLOY flow in SKILL.md (Mode Selection → Step 0).

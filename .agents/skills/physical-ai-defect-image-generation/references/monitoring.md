# DIG skill — Monitoring best practices

Authoritative monitoring discipline for the
`physical-ai-defect-image-generation` skill. SKILL.md's "OSMO Monitoring"
section and the Response Template's **Monitoring** line point here.

**Load this file before any `osmo workflow submit`, `osmo workflow query`,
`osmo workflow logs`, or `osmo workflow cancel` action in this skill.**
Re-read it on the first such action of every new conversation. Do not
paraphrase these rules from memory.

## Rules

1. **Long-running workflows go to a subsession watcher.** Any DIG
   workflow expected to exceed **10 minutes** wall-clock (in practice:
   every flow in `assets/configs/`) MUST be
   handed off to a background **subsession watcher** the moment
   `osmo workflow submit` returns a workflow id. The watcher polls in
   isolation and reports back to the main agent **only on terminal state
   transition** (`SUCCEEDED` / `FAILED` / `CANCELED`) or on an explicit
   user follow-up. Do not block the main session on polling.

2. **Spawn the watcher as a background subagent and back it with a
   bounded scheduled poll as a cronjob.** The watcher is a **subagent / sub-session**
   launched through whatever spawning primitive the host harness
   provides (e.g. `Task` with a background subagent type, `sessions_spawn`,
   `claude code` subagent, OpenAI Codex / Agents SDK session, a detached
   shell session, or any equivalent). Whatever the primitive, it MUST:

   - run in the background, independent of the main session;
   - be scoped to a single OSMO workflow id;
   - report back to the main agent only on terminal state transitions
     (per Rule 1) or on explicit user follow-up;
   - own its own poll loop — the main session must not block on it.

3. **Never cancel a workflow whose pod is still `RUNNING`, and never
   cancel without explicit user confirmation.** A non-progressing log
   tail is NOT a failure signal on its own. Known quiet-but-healthy
   windows include:

   - **IsaacSim / `structural_defect_generation.yaml`** — 7–10 min
     warmup with sparse log output and many benign warnings (RTX
     loading, USD parsing, zenity). Routinely
     misdiagnosed as "stuck".
   - **`usd2roi-render`** — scan_grid stage runs silently between
     per-cell crop emissions.
   - **`augment-image-edit`** — long pauses while waiting on the
     image-edit endpoint (`nvidia/Qwen-Image-Edit-NVPCB-OVSL2SL`)
     under queue pressure.
   - **`finetune-job`** — torchrun startup + dataset validation runs
     before the first step log appears.

   Before any `osmo workflow cancel`: (a) confirm the underlying pod is
   not `RUNNING` (a `RUNNING` pod with quiet logs is doing work — leave
   it alone); (b) state the suspected failure mode to the user and **ask
   for explicit confirmation** to cancel. Never auto-cancel on a
   timeout, a warning grep hit, or a status-poll error.

## Out of scope (use the cited reference instead)

- `osmo data download` mechanics on a `SUCCEEDED` run →
  `references/output_retrieval.md`.
- Rendering the anomaly tree / preview grid →
  `references/output_rendering.md`.
- Pre-submit preflight failures (creds / pod template / URL artifacts) →
  `references/preconditions.md` + `scripts/preflight_*.sh`.
- Component-internal debugging once a task's logs are in hand →
  `references/troubleshooting.md` and the component skill.

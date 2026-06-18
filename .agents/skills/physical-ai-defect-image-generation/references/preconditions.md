# Common preconditions — detail

Extended detail for the five preconditions summarized in `SKILL.md` §"Common Preconditions (all flows)". The summary in SKILL.md is the agent-facing quick reference; this file holds the long-form jq block, branching prose, and glass-zip procedure that the agent loads only when a check fails.

## §1 — OSMO credentials + tokens

One OSMO credential is required by the flow YAMLs:

- `hf-token` (GENERIC type) — used for every HF download, including gated `nvidia/Cosmos-AnomalyGen-*`, `nvidia/Cosmos-Predict2-*`, `nvidia/Spark-AnomalyGen-USD`, Glass-Masks, etc. (full repo list in `references/setup.md`).

No registry credential is needed: the `paidf-*` images are public on `nvcr.io/nvidia/` and pull anonymously (the YAMLs no longer reference `nvcr_io`). If image pulls fail (authorization error or `nvcr.io` rate-limiting), see `references/troubleshooting.md` → "nvcr.io image pull failures".

Run `scripts/preflight_credentials.sh` — authoritative check is that `hf-token` is provisioned. The `HF_TOKEN` env var only auto-sets a missing cred or runs the outbound HF probe; optional when `hf-token` already exists. Pass `--no-probe` in restricted-egress shells. Re-run on fresh conversations (tokens can expire); do NOT re-run before every submit inside the same conversation. See `references/setup.md` §"Credential check".

## §2 — Pod template

Skip outright when memory records `verified` / `user-confirmed` / `skipped-409` for the cluster. Otherwise the OSMO pod template must declare the `nvoptix` hostPath mount at `/usr/share/nvidia/nvoptix.bin` and a `dshm` emptyDir with `sizeLimit ≥ 16 GiB` (32 GiB preferred). Pre-submit check:

```bash
scripts/preflight_pod_template.sh   # add --min-dshm-gib 32 if your workflow needs the preferred size
```

Branch on the exit code (matches Step 0 §1):

- **exit 0** (template OK) → proceed; save "pod template verified" to memory (Step 0 §6) so future conversations skip the check.
- **exit 1** (template visible but missing nvoptix and/or dshm sizing) → the user has read permission, so they almost certainly have admin or admin-equivalent. The script prints which check failed; route to `physical-ai-infrastructure-setup-and-resilient-scaling` for the patch runbook (`osmo config update POD_TEMPLATE`). After a successful patch, re-run the script and save the verified state to memory.
- **exit 2** (HTTP 403 — user lacks read permission; `osmo profile list` will confirm `osmo-admin` is absent from `roles:`) → **do not stop yet**. Use `AskUserQuestion`: *"Your account can't read POD_TEMPLATE (403). Has your OSMO administrator already configured the cluster so it meets the DIG requirements — `nvoptix` hostPath mount at `/usr/share/nvidia/nvoptix.bin` AND `/dev/shm` ≥ 16 GiB?"* (Yes / No or unsure). On **Yes** → save "pod template user-confirmed" to memory (Step 0 §6) and proceed (runtime preflight is the safety net). On **No / unsure** → stop and tell them: *"Contact your OSMO administrator to ensure the nvoptix hostPath mount (`/usr/share/nvidia/nvoptix.bin`) and `/dev/shm` ≥ 16 GiB are present in POD_TEMPLATE — DIG workflows cannot run without them."*
- **exit 3** (HTTP 409 — some 6.3 ConfigMap-mode deployments disable the config CLI) → warn the user that the pre-submit gate is being skipped and that the in-pod runtime preflight (Step 0) is the only remaining check, then proceed; save the skip state to memory.
- **exit 4** (osmo / jq missing, or unexpected failure) → fix the environment and re-run; do not auto-skip.

Cadence: **once per conversation** (cache result in-conversation) and **once per user across conversations** when the memory entry from Step 0 §6 indicates the cluster is already verified or user-confirmed. The runtime in-pod preflight catches drift between checks and submission. Re-run this check after any pod-template patch (and clear the memory entry first).

## §3 — Required URL artifacts

Preflight before every flow submission:

```bash
DIG_URL_ROOT=<dig_url_root> scripts/preflight_urls.sh <flow> <usecase> [variant]
```

The script checks the per-flow URL checklist (see SKILL.md table) with `osmo data list --no-pager`. `<flow>` is `0` / `1` / `finetune`; `<variant>` is optional (`real-alignment` for Day 1 PCBA real-photo alignment, which adds `datasets/pcb/assets` to the checklist). Set `USE_PRETRAINED_CHECKPOINT=false` when preflighting a finetune-from-scratch run. If anything is missing, **stop and submit the relevant `setup/setup_<case>.yaml` + `setup/setup_pretrained.yaml` first** or upload the artifact under the same DIG root — see `references/setup.md`.

Built-in `usecase` values are `pcb`, `metal_surface`, and `glass` — uniform across the `--set usecase=` knob, URL datasets (`datasets/<usecase>/raw`), model checkpoints (`models/<usecase>`), and cookbook directories (`assets/cookbooks/<usecase>/ag_config.yaml`). `metal_surface` matches the trained model's material name (the `anomaly_types_json=[["metal_surface","MT_*"],...]` taxonomy baked into the checkpoint) — no translation layer.

The PCBA assets artifact ships the USD tree only — `pcba_target.yaml`, `day0_image.yaml` (with mesh-level semantics inlined), and `day0_crop.yaml` mount from the per-board cookbook (`assets/cookbooks/pcb/<board>/`) at task start, so the URL artifact doesn't need them.

### Shipped checkpoint and `anomaly_types_json` defaults

Passthrough runs (`use_pretrained_checkpoint=true`, default) need no further knobs; the YAMLs ship per-usecase `checkpoint_step` and `anomaly_types_json` defaults below. Override only when running a custom-trained checkpoint or narrowing the defect set. Day 0 Good Image and Day 0 Structural Defects have no AnomalyGen step — neither knob applies.

| Flow | Use case | `checkpoint_step` | Shipped `anomaly_types_json` |
|---|---|---|---|
| Day 0 Texture | `pcb` | `14000` | `[["IC","bridge"],["passive_component","excess_solder"],["passive_component","missing"]]` |
| Day 1 (manual + real-align) | `pcb` | `14000` | `[["passive_component","missing"]]` (narrow default; override for multi-type) |
| Day 1 manual | `metal_surface` | `10000` | `[["metal_surface","MT_Blowhole"],["metal_surface","MT_Break"],["metal_surface","MT_Crack"],["metal_surface","MT_Fray"],["metal_surface","MT_Uneven"]]` |
| Day 1 manual | `glass` | `9000` | `[["Phone","oil"],["Phone","scratch"],["Phone","stain"]]` |

Day 1 YAMLs auto-swap `checkpoint_step` and `anomaly_types_json` from the PCBA defaults (`14000` / `[["passive_component","missing"]]`) to the per-usecase rows above when the user does not override at submit time.

## §4 — Name stamping

Production YAMLs ship no `name` default (avoids silent overwrites on repeat submits); every submit MUST pass `--set name=<flow>-$STAMP`.

```bash
STAMP=$(cat /proc/sys/kernel/random/uuid | cut -c1-8)
osmo workflow submit assets/configs/<flow>.yaml --pool <pool> \
  --set name=<flow>-$STAMP \
        <other knobs>
```

Regenerate `$STAMP` fresh before every submit (don't reuse across submits in the same shell), echo it back so the user can find outputs at `runs/<flow>-<stamp>/...`. Missing `name` fails validate with `Jinja substitution failure: 'name' is undefined`.

## §4a — Memory rules (cross-conversation state)

After the first-time gate resolves — and after any submit where the user explicitly diverged from a documented default — persist load-bearing choices so future sessions don't re-ask. Save as reference / user memories using the auto-memory system.

| What | Memory type | When to save |
|---|---|---|
| `dig_url_root` value the user picked | reference | After first-time setup (or whenever the user changes buckets). |
| OSMO `--pool` the user typically submits against | user | After the first successful submit; update if the user switches pools. |
| Default board (`0603_H100` / `1152819000` / custom) | user | Only if the user explicitly diverges from the workflow default. |
| `image_edit_endpoint` URL when using Option A (existing endpoint) | reference | After the user confirms an existing endpoint URL; do NOT save the in-cluster Option B service DNS — that's derivable from `references/nim/`. |
| Pod template state: `verified` (jq passed) / `user-confirmed` (403 + user yes-answered) / `skipped-409` (CLI disabled) | reference | After §2 resolves successfully. Lets future conversations skip the §2 check entirely; runtime in-pod preflight is the safety net. Clear this entry if the cluster is reconfigured (e.g., admin patches the template). |
| OSMO `osmo-admin` role: present / absent | user | After first `osmo profile list` read. Saves re-discovery; if absent, agents know not to even attempt `osmo config update POD_TEMPLATE`. Refresh if the user mentions being added to / removed from groups. |
| `image_edit_model` | DO NOT SAVE | Always `nvidia/Qwen-Image-Edit-NVPCB-OVSL2SL`; saving it as a "preference" would invite drift to the wrong model. |
| Ephemeral state (a specific run STAMP, one-off `anomaly_types_json`, debug context) | DO NOT SAVE | Conversation-scope only. |

At the **start** of every new conversation about this skill, read the relevant memories and apply them silently. If a recalled memory conflicts with what the user is asking for now, trust the current request and offer to update the memory.

## §5 — Glass case (UC3) — Roboflow zip prerequisite

Only when running `setup/setup_glass.yaml`. The license-gated Roboflow Mobile-Screen COCO export must be uploaded to an OSMO URL prefix **before** submitting `setup_glass.yaml`. If you are about to run glass setup, verify with `osmo data list --no-pager <prefix>/` that `mobile_screen.zip` is present, then pass `--set uc3_zip_url_root=<prefix>`. Empty `uc3_zip_url_root` fails validation. **Do not skip ahead to submit** — there is no auto-download step. Full procedure (browser export, rename to `mobile_screen.zip`, `osmo data upload`) lives in `references/setup.md` §"Glass case (UC3)".

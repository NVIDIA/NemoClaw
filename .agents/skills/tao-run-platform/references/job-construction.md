# Submitting a Job: Entrypoint and Spec Construction

The agent always **constructs the container command via `build_entrypoint`** before calling `create_job`. The agent reads the action's schema from `skill_info.yaml` (`command`, `config_format`, `inputs`, `outputs`, `upload_excludes`) and passes those fields as kwargs. `build_entrypoint` then bakes:

1. The in-container `script_runner` runtime (inlined as a base64 heredoc — no need for `tao_sdk` to be installed in the container).
2. The CLI invocation that, at runtime in the container, will: download declared inputs (S3 / HF-Hub / NGC), write the spec file at `{config_path}` with remote URIs rewritten to local paths, run the user command, and upload outputs.

Output destinations are resolved at runtime from env vars the SDK injects (see [`outputs.md`](outputs.md)). The platform SDK's `create_job` runs the resulting command **as-is** — no inputs/outputs kwargs, no implicit wrapping. The data flow is visible in the agent's code.

For where outputs land and the critical nested-dict-vs-dotted-key spec rule, see [`outputs.md`](outputs.md).

## Constructing the spec / args

The skill's action declares its config mechanism in `skill_info.yaml`'s `actions.<action>.mode` field (defaulting to `config` when absent). The agent's construction strategy follows from that:

| `mode` | How to construct |
|---|---|
| `args` | Copy the `actions.<a>.args` block from `skill_info.yaml` as your template. Substitute placeholders (`{storage_root}`, `{split_id}`, `{num_gpus}`, etc.) with the user's runtime values. Pass to `build_entrypoint(args=...)`. |
| `config` + `references/spec_template_<a>.yaml` exists | Load the template via `yaml.safe_load(...)` as the base spec; apply user overrides on top. Pass to `build_entrypoint(specs=...)`. |
| `config`, no template | Follow the model's `SKILL.md` — typically a "Critical Overrides" section lists which keys must be set. Construct the spec accordingly. Pass to `build_entrypoint(specs=...)`. |
| `passthrough` | Bare command + path-keyed `inputs={container_path: uri}` / `outputs=[paths]`. Pass to `build_entrypoint(inputs=..., outputs=...)`. |

**Recommended decision order:**

1. Read `action_cfg = skill_info["actions"][action]`. Check `action_cfg.get("mode", "config")`.
2. For `config` mode: check `references/spec_template_<action>.yaml`. If it exists, **load it as your base** — don't rebuild from scratch.
3. Apply user overrides on top (plus any "Critical Overrides" rows from the model's `SKILL.md`).
4. For `args` mode: copy `action_cfg["args"]`, fill placeholders, hand to `build_entrypoint(args=...)`.

```python
import yaml
from pathlib import Path

skill_dir = Path(bank) / "skills/models/<model>"
skill_info = yaml.safe_load((skill_dir / "references/skill_info.yaml").read_text())
action_cfg = skill_info["actions"][action]
mode = action_cfg.get("mode", "config")

if mode == "args":
    args = dict(action_cfg["args"])
    args["weak-video-list"] = args["weak-video-list"].format(storage_root=user_storage)
    # ... substitute remaining placeholders
    ep = build_entrypoint(command=action_cfg["command"], args=args, ...)

elif mode == "config":
    template = skill_dir / f"references/spec_template_{action}.yaml"
    specs = yaml.safe_load(template.read_text()) if template.exists() else {}
    # apply user overrides on top
    specs.setdefault("policy", {})["model_name_or_path"] = user_model
    # ... etc
    ep = build_entrypoint(command=action_cfg["command"], specs=specs, ...)
```

## Mode inference (you don't pass `mode`)

`build_entrypoint` infers the mode from what the agent passes:

| What the agent passes | Inferred mode |
|---|---|
| `specs=...` (with optional spec-keyed `inputs` / `outputs`) | `config` — write spec file, rewrite URIs, run command |
| `args=...` (with optional spec-keyed `inputs` / `outputs`) | `args` — substitute CLI args into the command template |
| `inputs=...` and/or `outputs=...` only (path-keyed) | `passthrough` — download to listed paths, run, upload |
| nothing extra (just `command`) | `passthrough` with no I/O — bare command |

One helper, one signature.

## Resolving container images

Skills declare images either by key (`tao_toolkit.pyt`) or as an absolute URI (`nvcr.io/...`). Use `resolve_container_image()` to handle both:

```python
from tao_sdk.versions import resolve_container_image
image = resolve_container_image(skill_info["container_image"])
```

Behind the scenes it walks `versions.yaml` for keys; absolute URIs are returned as-is.

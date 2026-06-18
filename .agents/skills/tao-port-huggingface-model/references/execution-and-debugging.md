<!--
Copyright (c) 2026, NVIDIA CORPORATION.  All rights reserved.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
-->

# Execution Platform, Environment Isolation & Debugging

Cross-cutting operational rules for the TAO-HF integration workflow: which container runs what, how Python environments stay isolated, the build-test-debug loop, and the symptom-to-fix debugging playbook.

---

## Submodule Override — Working-Directory Layout

The user clones the four TAO repos (`tao-core`, `tao-pytorch`, `tao-deploy`, `tao-dataservices`) independently into one working directory:

```
working-directory/
├── tao-core/             ← independently cloned — modifications go HERE
├── tao-pytorch/
│   └── tao-core/        ← submodule at original commit (stale — DO NOT use)
├── tao-deploy/
│   └── tao-core/        ← submodule at original commit (stale — DO NOT use)
└── tao-dataservices/
    ├── tao-core/        ← submodule at original commit
    └── tao-pytorch/     ← submodule at original commit
```

The nested `tao-core/` submodules inside each repo point to the **original unmodified commit**. Modifications only exist in the top-level `tao-core/`. **Always install from the top-level `tao-core/`, never from `<repo>/tao-core/`.** In CI, Jenkinsfiles run `pip install tao-core/` (the submodule); the local override mounts the whole working directory at `/workspace`, installs `/workspace/tao-core` first, and puts the top-level tao-core first on `PYTHONPATH`. Using the nested submodule silently ignores all modifications — model configs, backbone mappings, etc. would not be present.

---

## Execution platform

Every test, smoke run, and end-to-end validation runs inside a locally prepared
TAO Toolkit container (`tao-pytorch-base:latest`, `tao-deploy-base:latest`,
optionally `tao-dataservices-base:latest` — all prepared in Phase 0). The
platform skills own the *how* of running those containers; this workflow only
specifies *what* to run inside them.

| Concern | Authoritative skill |
|---|---|
| GPU host runtime — NVIDIA driver 580, CUDA Toolkit 13.0, NVIDIA Container Toolkit 1.19.0 | [`tao-skill-bank:tao-setup-nvidia-gpu-host`](../../../platform/tao-setup-nvidia-gpu-host/SKILL.md) |
| `docker run` flags, NGC auth, `--gpus`, mounts, env passthrough, `--ipc=host`/`--shm-size`, container inspection, common error modes | [`tao-skill-bank:tao-run-on-docker`](../../../platform/tao-run-on-docker/SKILL.md) |
| Local Docker daemon preflight + per-job invocation | [`tao-skill-bank:tao-run-on-local-docker`](../../../platform/tao-run-on-local-docker/SKILL.md) |

**Default platform:** `local-docker`. This workflow requires bind-mounting
your local clones of `tao-core`, `tao-pytorch`, `tao-deploy`, and
`tao-dataservices` into the container at `/workspace`, then installing the
modified source via `pip install /workspace/tao-core` and `setup.py develop`.
That layout only makes sense against a Docker daemon you control. The Local
Only Rule is the corollary: no remote registry pushes, no remote job
submissions.

**GPU runtime preflight:** Phase 0 delegates the driver / CUDA / NCT checks
to the `tao-setup-nvidia-gpu-host` skill rather than duplicating them here. NGC
`docker login`, image pulls, and the published-image preparation step remain
in Phase 0 — those are the only TAO-Toolkit-specific bits.

**Docker run conventions:** every `docker run` invocation in Phases 3 / 4 /
6 follows the canonical flag set from `skills/platform/tao-run-on-docker/SKILL.md` (`--gpus
all`, `-v` bind mounts, `-e VAR` passthrough, `--shm-size=16G` for
DataLoader-heavy pytest, `--rm` for one-shots). The phase reference files
only specify the *workflow-specific* additions (`-w /workspace/<repo>`,
`PYTHONPATH=/workspace/tao-core:/workspace/<repo>`, the inner
`pip install /workspace/tao-core && python setup.py develop && pytest ...`
shell). If anything about the generic conventions changes, change it in the
docker platform skill — do not fork them inside this workflow.

---

## Development Loop

At every implementation step:

```
1. Write code
2. Test immediately (import check, unit test, or dry-run)
3. If it fails → read traceback → diagnose root cause → fix → go to 2
4. If it passes → move to next step
```

Do NOT accumulate untested code across multiple steps. Test early, test often. Writing all files first and only testing at the end makes debugging much harder because multiple bugs compound.

---

## Environment Isolation Strategy

All Python work runs **inside Docker containers** — no host venvs, no
`pip install`s into host Python. The same `tao-pytorch-base:latest` image
that Phases 3/4/6 use is also used for Phase 1's HF inspection, so the host
needs only Docker (provided by `tao-setup-nvidia-gpu-host`) and never needs
`python3-pip` / `python3-venv` / a particular Python version.

- **Context A — HF model inspection (Phase 1):** launch a long-lived
  `tao-pytorch-base:latest` container named `tao-hf-inspect`, bind-mount a
  host scratch dir at `/workspace`, and run each probe step via `docker
  exec`. A `python:3.12-slim` fallback is documented for environments where
  Phase 0 hasn't been run yet. Full commands in `phase-1-inspection.md`.
- **Context B — Incremental smoke tests (Phase 3/4):** run inside the
  prepared TAO Toolkit container (`docker run ... tao-pytorch-base:latest`)
  with the local source bind-mounted and installed via `pip install
  /workspace/tao-core && python setup.py develop`.
- **Context C — Temporary files:** scratch lives under the host bind-mount
  (e.g. `./.phase1`) so files end up host-user-owned (`--user $(id -u):$(id -g)`).
  Remove the scratch dir after the phase that created it, or keep it
  between runs to skip model redownloads.

Rules:

1. `pip install` — NEVER into the host/system Python. Always inside a
   container.
2. Host-level system packages (`docker`, `git`, kernel headers, NVIDIA
   Container Toolkit) are owned by the `tao-setup-nvidia-gpu-host` skill, which
   handles the distro-specific package manager (`apt-get` on Debian/Ubuntu
   and derivatives, `dnf` / `yum` on Fedora/RHEL/Rocky/Alma, `zypper` on
   openSUSE/SLES, manual instructions for other distros). This workflow never
   issues `apt`/`dnf`/`zypper` commands directly — it only invokes
   `tao-setup-nvidia-gpu-host --check-only` and surfaces the error.
3. **Container UID convention — depends on the workload:**
   - Phase 1 inspection (Context A) — runs `python -c "..."` against
     pre-installed wheels in `tao-pytorch-base:latest`. **Pass
     `--user $(id -u):$(id -g)`**; HF cache + the `tao_hf_test.onnx`
     scratch file end up host-user-owned. The fallback path on
     `python:3.12-slim` does pip-install-at-startup, so it also sets
     `HOME=/workspace` + `PIP_USER=1` to route the install into a
     bind-mounted user-site instead of the root-owned system
     `site-packages`.
   - Phase 3 / 4 / 6 (Context B) — every smoke test, L0 test, and the
     end-to-end pipeline run `pip install /workspace/tao-core && python
     setup.py develop` against the container's **system** site-packages
     (root-owned). These invocations therefore run **as root** (no
     `--user`) and accept the trade-off that `*.egg-info/`, `build/`,
     `.pytest_cache/`, `dist/`, and `__pycache__/` left in
     `/workspace/tao-*` end up `root:root`. `sudo rm -rf` them or leave
     them between iterations — none of them is a source artifact.
4. Remove the long-lived inspection container (`docker rm -f
   tao-hf-inspect`) at the end of Phase 1.

---

## Debugging Playbook

When something fails, consult this before trying random fixes:

| Symptom | Likely cause | Fix |
|---|---|---|
| `ModuleNotFoundError` | Missing `__init__.py` or wrong PYTHONPATH | Add `__init__.py` to every package dir; check PYTHONPATH in docker command |
| `KeyError` in `BACKBONE_REGISTRY` | Backbone not registered or not imported | Add import to `backbone_v2/__init__.py`; verify `@BACKBONE_REGISTRY.register()` |
| Shape mismatch in forward pass | `head.in_channels` doesn't match backbone output dim | Check `model_params_mapping.py`; print backbone output shape |
| NaN loss after first epoch | LR too high, or wrong data normalization | Reduce LR by 10×; verify `augmentation.mean/std` matches model expectations |
| ONNX export fails | Unsupported op or dynamic control flow | Identify failing op; try `opset_version=17`; rewrite the op if needed |
| TRT engine build fails | ONNX graph has unsupported TRT ops | Run `trtexec --onnx=model.onnx` to identify failing layer; may need plugin |
| TRT accuracy << PyTorch | Preprocessing mismatch or precision loss | Compare `augmentation.mean/std` across specs; try FP32 engine first |
| OOM during training | Batch size too large or activation memory | Reduce `dataset.batch_size`; enable activation checkpointing; use FP16 |
| DDP hangs | Unused parameters in forward | `strategy='ddp_find_unused_parameters_true'` |
| Checkpoint load fails (missing keys) | State dict key mismatch | `strict=False` in `load_state_dict()`; check key mapping |
| `results_dir` files not created | Path doesn't exist or wrong permissions | `os.makedirs(results_dir, exist_ok=True)` |
| Config changes not taking effect | Stale submodule copy of tao-core | Verify `-v $(pwd):/workspace`; `pip install /workspace/tao-core` runs first |

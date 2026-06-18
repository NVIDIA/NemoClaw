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

# Compatibility Workarounds Registry

Known HuggingFace / PyTorch / NVIDIA ecosystem incompatibilities with auto-detection rules.
Consulted in **Phase 0.5** to write `meta/phase0_compat.yaml`. Phase 4.3 reads that file and
injects only the applicable fixes into the generated Dockerfile or config.

**Adding a new workaround:** when you hit a new bug and fix it for one project, add an entry
here. Future generated projects auto-inherit the fix.

---

## Entry format

```yaml
id: <short-kebab-case-id>
title: <one line>
symptom: <exact error the user sees>
root_cause: <one line>
detect:                            # any/all field = Python expression on phase0 vars
  any:                             # match if ANY expression is True
    - "cfg.model_type == 'idefics3'"
    - "getattr(cfg, 'text_config', None) and cfg.text_config.model_type == 'llama'"
fix:
  type: dockerfile_block | config_override | requirements_pin | runtime_env | dataset_template | naming_rule
  content: |
    <text/dict to inject>
references: [<links or PRs>]
```

**Detection vars available in `detect` expressions:**
- `cfg` — `AutoConfig.from_pretrained(model_id)` result
- `hw` — `meta/phase1_hardware.yaml` dict (ngc_image, driver_major, gpu_name, etc.)
- `task` — detected task string (image-classification, image-text-to-text, ...)

---

## Registry

### 1. `idefics3-llama-generate`

```yaml
id: idefics3-llama-generate
title: Idefics3/Llama-backed VLM generate() broken on transformers ≥ 4.51
symptom: |
  TypeError: Missing `**kwargs` in the signature of the `@check_model_inputs`-decorated
  function (LlamaModel.forward)
root_cause: |
  transformers 4.51 introduced @check_model_inputs which expects **kwargs in the wrapped
  forward. Idefics3 wraps LlamaModel as text_model; LlamaModel.forward doesn't advertise
  **kwargs in its signature, so the decorator raises at generate() time.
detect:
  any:
    - "cfg.model_type in {'idefics3', 'mllama', 'llava', 'llava_next'}"
    - "getattr(cfg, 'text_config', None) is not None and getattr(cfg.text_config, 'model_type', '') == 'llama'"
fix:
  type: dockerfile_block
  content: |
    # Workaround idefics3-llama-generate — transformers ≥ 4.51 breaks LlamaModel.forward
    RUN pip install --no-cache-dir --force-reinstall --no-deps \
        transformers==4.49.0 tokenizers==0.21.0 "huggingface-hub>=0.26,<1.0"
references:
  - https://github.com/huggingface/transformers/issues/35928
```

### 2. `pytorch-2.5-sdpa-gqa`

```yaml
id: pytorch-2.5-sdpa-gqa
title: PyTorch 2.5.0 SDPA crashes on grouped-query attention
symptom: |
  TypeError: scaled_dot_product_attention() got an unexpected keyword argument 'enable_gqa'
root_cause: |
  PyTorch 2.5.0 (shipped in NGC 24.09-py3) called SDPA without checking GQA support. Fixed
  in 2.5.1. Affects any model with num_key_value_heads < num_attention_heads (Llama 3,
  Mistral, Qwen2, Gemma, etc.).
detect:
  all:
    - "'24.09-py3' in hw['ngc_image']"
    - "getattr(cfg, 'num_key_value_heads', None) is not None and cfg.num_key_value_heads < cfg.num_attention_heads"
fix:
  type: config_override
  content:
    attn_implementation: "eager"
references:
  - https://github.com/pytorch/pytorch/pull/137524
```

### 3. `hf-hub-xet-hang`

```yaml
id: hf-hub-xet-hang
title: HF Hub Xet CDN downloads hang at 0 bytes intermittently
symptom: |
  prepare_data.py or model load stalls at 0 bytes on a .incomplete blob for many minutes
root_cause: |
  HuggingFace's Xet CDN (new dedup-aware storage) has intermittent timeouts on some routes.
  The legacy LFS path is reliable.
detect:
  any:
    - "True"                   # always apply (benign)
fix:
  type: runtime_env
  content:
    HF_HUB_DISABLE_XET: "1"
references:
  - https://github.com/huggingface/huggingface_hub/issues/2700
```

### 4. `vlm-heterogeneous-pixel-values`

```yaml
id: vlm-heterogeneous-pixel-values
title: VLM pixel_values can have variable num_images per sample — collator must pad
symptom: |
  AttributeError: 'list' object has no attribute 'shape'
  — raised inside Idefics3/SmolVLM get_image_features when pixel_values couldn't be stacked
root_cause: |
  Idefics3-family processors split high-res images into tiles; the leading dim `num_images`
  can differ between samples in a batch. A naive torch.stack collator returns a Python list,
  which the model then dereferences as a Tensor.
detect:
  any:
    - "cfg.model_type in {'idefics3', 'idefics2', 'mllama'}"
    - "task == 'image-text-to-text' and getattr(cfg, 'do_image_splitting', False)"
fix:
  type: dataset_template
  content:
    collator: collate_vlm
    sample_padding: none
    rationale: "Use the heterogeneous-safe collator from references/vlm-scripts.md §collate_vlm"
references:
  - This skill's own production bug — caught by Phase 4.5 after the fact
```

### 5. `script-name-evaluate`

```yaml
id: script-name-evaluate
title: Script named evaluate.py collides with HF evaluate library
symptom: |
  ImportError: cannot import name 'main' from 'evaluate'
  (at wheel install time or first hft-eval call)
root_cause: |
  The HF `evaluate` library is installed as a top-level `evaluate` module in site-packages.
  A wheel whose entry point points to `evaluate:main` gets shadowed at runtime.
detect:
  any:
    - "True"
fix:
  type: naming_rule
  content:
    script_file: run_eval.py
    entry_point: "hft-eval=run_eval:main"
references:
  - Enforced by the skill at generation time
```

### 6. `vlm-image-token-truncation`

```yaml
id: vlm-image-token-truncation
title: VLM truncation=True at max_length<prompt_length cuts mid-image-token
symptom: |
  ValueError: Mismatch in `image` token count between text and `input_ids`.
root_cause: |
  Idefics3 / Qwen2-VL / LLaVA-Next expand an image into ~800+ text tokens in the prompt.
  A dataset __getitem__ that sets truncation=True with max_length<prompt_length cuts
  inside the image-token span, breaking alignment with pixel_values.
detect:
  any:
    - "task == 'image-text-to-text'"
fix:
  type: dataset_template
  content:
    sample_truncation: false
    sample_padding: none
    rationale: "No truncation/padding in __getitem__ — let collator handle batch padding"
references:
  - See vlm-scripts.md VLMDataset template
```

### 7. `pip-cache-purge-ngc`

```yaml
id: pip-cache-purge-ngc
title: pip cache purge fails in NGC base images
symptom: |
  ERROR: pip cache directory is not configured
  — during Docker build when `RUN pip cache purge` is executed
root_cause: |
  NGC PyTorch images disable pip's cache by default to keep images small. Any Dockerfile
  line calling `pip cache purge` fails.
detect:
  all:
    - "'nvcr.io/nvidia/pytorch' in hw['ngc_image']"
fix:
  type: dockerfile_lint
  content:
    forbidden_lines: ["pip cache purge"]
references:
  - NGC release notes
```

### 8. `wheel-find-packages-empty`

```yaml
id: wheel-find-packages-empty
title: setup.py find_packages() returns empty for flat-script projects
symptom: |
  Wheel builds successfully but is < 5 KB; entry points fail with ModuleNotFoundError at install
root_cause: |
  setuptools.find_packages() requires each Python file to live in a directory with __init__.py.
  The skill generates flat top-level scripts (train.py, model.py, ...), so find_packages()
  returns [] and the wheel ships zero code.
detect:
  any:
    - "True"
fix:
  type: naming_rule
  content:
    setup_py_modules: py_modules
    forbid: find_packages()
references:
  - See references/packaging.md
```

---

## Phase 0.5 runner (pseudocode)

```python
# Inputs
cfg  = AutoConfig.from_pretrained(model_id, trust_remote_code=True)
hw   = yaml.safe_load(open("meta/phase1_hardware.yaml"))
task = yaml.safe_load(open("meta/phase0_model_info.yaml"))["task"]

# Load registry (parse this .md file's YAML blocks, or maintain a parallel .yaml)
registry = load_compat_registry()

def match_rules(rules, **ctx):
    """Evaluate detect expressions. `any`/`all` semantics."""
    if "any" in rules:
        return any(eval(expr, {}, ctx) for expr in rules["any"])
    if "all" in rules:
        return all(eval(expr, {}, ctx) for expr in rules["all"])
    return False

applied = []
skip = set(yaml.safe_load(open("config.yaml")).get("skip_workarounds", []))
for entry in registry:
    if entry["id"] in skip:
        continue
    if match_rules(entry["detect"], cfg=cfg, hw=hw, task=task):
        applied.append(entry)

yaml.safe_dump({"applicable_workarounds": applied},
               open("meta/phase0_compat.yaml", "w"))

for a in applied:
    log_progress(f"Compat: applying '{a['id']}' — {a['title']}", status="⚠️")
```

---

## Phase 4.3 Dockerfile injection (pseudocode)

```python
compat = yaml.safe_load(open("meta/phase0_compat.yaml"))["applicable_workarounds"]

dockerfile = render_base_dockerfile(ngc_image=ngc_image)

# Dockerfile-level injections
for entry in compat:
    if entry["fix"]["type"] == "dockerfile_block":
        # Insert after the Python-deps layer, before project wheel copy
        dockerfile = inject_after(dockerfile,
                                  marker="RUN pip install --no-cache-dir -r requirements.txt",
                                  block=entry["fix"]["content"])
    elif entry["fix"]["type"] == "runtime_env":
        dockerfile = append_env(dockerfile, entry["fix"]["content"])

write("Dockerfile", dockerfile)

# Config overrides merged into config.yaml
cfg_overrides = {k: v for entry in compat if entry["fix"]["type"] == "config_override"
                 for k, v in entry["fix"]["content"].items()}
if cfg_overrides:
    merge_yaml("config.yaml", cfg_overrides)
    log_progress(f"Compat: applied config overrides {list(cfg_overrides)}", status="⚠️")

# Dataset-template and naming-rule entries are enforced at Phase 4 generation time,
# not post-processed here.
```

---

## Invariants

1. **Applicable-set is the minimum fix set.** Every fix has a matching detection rule.
   No speculative fixes.
2. **Registry is the single source of truth.** When this file grows, every future generated
   project benefits automatically.
3. **The skill never silently applies a fix.** Every applied workaround logged in PROGRESS.md.
4. **Users can override** via `skip_workarounds: [<id>]` in `config.yaml`.

---

## When to add to this registry

You've hit a new HF / PyTorch / NVIDIA incompatibility and fixed it. Add an entry with:
- The exact error the user would see
- The one-line root cause
- A detection rule that's specific enough to not fire on unrelated models
- The minimal fix (Dockerfile line, config value, env var)

Avoid adding entries for:
- **Bugs in the skill itself** — those should be fixed in the skill, not patched in generated code
- **Model-specific performance tuning** — goes in config.yaml, not a fix
- **Workarounds a user could reasonably discover from the error message** (e.g. "add --shm-size")

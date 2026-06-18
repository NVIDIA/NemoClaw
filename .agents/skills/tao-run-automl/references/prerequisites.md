# AutoML Prerequisites

What must be satisfied before running AutoML, in detail: the shared launch preflight, SDK credentials, dataset URI formats, the skill bank layout and `skill_dir`, and the `nvidia-tao-automl` install.

Before running AutoML:

1. **Shared launch preflight**: Run the `tao-launch-workflow` intake pattern first. AutoML must not create runner files, workspaces, state files, logs, compatibility shims, or install dependencies until the selected platform's credentials, access check, dataset visibility, model credentials, container image confirmation, and compute shape are satisfied. This prevents wasting the AutoML budget on fake recommendation failures caused by SSH, storage, image, or credential setup.
2. **SDK credentials**: env vars sourced from `~/.config/tao/.env` (auto-loaded by the skill bank's SessionStart hook). Required env vars depend on which SDK you choose — see each platform's SKILL.md (`skills/platform/tao-run-on-lepton`, `skills/platform/tao-run-on-brev`, `skills/platform/tao-run-on-slurm`, `skills/platform/tao-run-on-kubernetes`, `skills/platform/tao-run-on-local-docker`). Before asking for credentials, run:
   ```bash
   ${TAO_SKILL_BANK_PATH:-~/tao-skills-external}/scripts/list_tao_platforms.py \
     --skill-bank ${TAO_SKILL_BANK_PATH:-~/tao-skills-external} \
     --platform <platform> --format text
   ```
   Ask only for credentials from that output. For example, SLURM needs SLURM credentials and not Lepton or S3 credentials; Kubernetes and local Docker do not need SLURM or Lepton credentials. Ask S3 credentials only when the selected platform and dataset/result URIs use `s3://`. For container pulls: `NGC_KEY`. The agent never reads values — only checks presence with `[ -n "$VAR_NAME" ]`. Construct the SDK with no arguments — e.g., `LeptonSDK()`, `BrevSDK()`, `SlurmSDK()`, `KubernetesSDK()`, or `DockerSDK()`.
3. **Dataset**: Training data accessible from the compute backend. URI format depends on the SDK's platform:
   - Lepton / DGX Cloud: `s3://bucket/path` (S3-compatible; do not generate `aws://...`)
   - Slurm / internal shared storage: an absolute shared filesystem path visible to the Slurm job, e.g. `/lustre/fsw/tao_datasets/<model>/train` and `/lustre/fsw/tao_datasets/<model>/eval`
   - Azure: `azure://container/path`
   - Local / Docker: local filesystem path
   Accept either dataset roots or exact spec-key paths. For exact spec paths,
   preserve user-supplied keys such as
   `custom.train_dataset.annotation_path=/lustre/.../annotations.json` and
   `custom.train_dataset.media_path=/lustre/.../videos.tar.gz`; do not force
   both files to share one parent directory.
4. **Skill bank available**: the runner takes an explicit `skill_dir` — the **absolute path to a model directory** inside the skill bank, e.g. `<bank-root>/models/tao-train-dino`. No global env var; pass per run. The agent already knows the bank root (it loaded the workflow from there) — use that same root. Common locations:
   - cloned standalone: `~/tao-skills-external/` (or wherever the user cloned).
   - Claude Code plugin: `~/.claude/plugins/cache/tao-skill-bank/<version>/`.
   - Codex plugin: `~/.codex/plugins/cache/<marketplace>/tao-skill-bank/<version>/`.
   - submodule inside a cloned SDK: `<sdk>/tao-skills-external/`.
   ```python
   from pathlib import Path
   SKILL_BANK = Path("<bank-root>")        # substitute the actual path
   skill_dir  = SKILL_BANK / "models" / network_arch
   ```
   The bank structure is:
   ```
   tao-skills-external/
   ├── applications/         # workflow configs (this skill)
   ├── models/               # per-network skill packages
   │   ├── <network>/
   │   │   ├── SKILL.md
   │   │   ├── schemas/
   │   │   │   └── train.schema.json          # REQUIRED AutoML gate
   │   │   └── references/
   │   │       ├── skill_info.yaml             # actions, data_sources, container image
   │   │       └── spec_template_train.yaml    # default training spec (recommended)
   │   └── ...
   ├── data/
   └── platform/
   ```
   **CRITICAL**: AutoML requires a packaged generated train dataclass schema at `<bank-root>/models/<network>/schemas/train.schema.json`. The schema must exist and parse as JSON — it's the AutoML support gate because it defines `automl_enabled` parameters, defaults, ranges, options, weights, and popular metadata. Schemas are generated during skill-bank maintenance and shipped with the plugin; the runtime must not expect `~/tao-core` to exist. If the packaged train schema is missing, do not run AutoML for that model.

   `references/spec_template_<action>.yaml` is required for **non-TAO-Core models** (cosmos-rl, clip, etc.) — without it the runner has no defaults and the trial spec will be missing keys. For **TAO Core / Hydra-based models** (DINO, BEVFusion, etc.) the template is optional; Hydra fills container-side defaults at runtime.
5. **`nvidia-tao-automl` installed** with the platform extra you want. On public PyPI; pin lives in `versions.yaml` (`wheels.tao_automl_*`):
   ```bash
   SB="${TAO_SKILL_BANK_PATH:?}"
   pip install "$($SB/scripts/resolve_versions_key.py wheels.tao_automl_lepton)"   # or _slurm, _kubernetes, _docker, _brev, _all
   # With LLM/agentic algorithms, append ,llm to the extra:
   pip install "$($SB/scripts/resolve_versions_key.py wheels.tao_automl_lepton | sed 's/]/,llm]/')"
   ```
   For local development against a checkout: `pip install -e '~/tao-run-automl[lepton]'`.

# Troubleshooting & CI Gotchas

Read this when a build, test, or CI step fails — symptoms, causes, fixes.

## Common Pitfalls

| Problem | Solution |
|---------|----------|
| Cython changes not reflected | Rerun: `./build.sh cuopt` |
| Missing `nvcc` | Set `$CUDACXX` or add CUDA to `$PATH` |
| OOM during build | Lower `PARALLEL_LEVEL` (e.g., `export PARALLEL_LEVEL=8`) |
| CUDA out of memory | Reduce problem size |
| Build fails with CUDA errors on older driver | Conda installs `cuda-nvcc` for the latest supported CUDA (e.g., 13.1), but the user's GPU driver may not support it. Have the user check with `nvidia-smi` — the top-right shows max CUDA version. Provide this command for the user to run (do not run it yourself): `conda install cuda-nvcc=12.9` (or whichever version their driver supports). See [CUDA compatibility matrix](https://docs.nvidia.com/deploy/cuda-compatibility/) |
| Slow debug library loading | Device symbols cause delay |

## CI Gotchas

| Failure | Cause | Fix |
|---------|-------|-----|
| Style check | Formatting drift | Run `pre-commit run --all-files` and commit fixes |
| DCO sign-off | Missing `-s` flag | `git commit --amend -s` (or rebase to fix older commits) |
| Dependency mismatch | Edited `pyproject.toml` or `conda/environments/` directly | Edit `dependencies.yaml` instead, let pre-commit regenerate |
| Cross-suffix dep collision (e.g. `cuopt-sh-client` → `cuopt`) | A pure-Python (CUDA-agnostic) wheel transitively depends on a CUDA-suffixed sibling. PyPI only publishes the `*-cu12` / `*-cu13` variants, which install to the same Python package directory and cannot coexist. An unsuffixed pin fails to resolve; a hardcoded suffix collides with the other suffix when a co-installed package (e.g. `cuopt-server-cu12`) pulls in the opposite one. | Avoid the hard dep. Make the import lazy (`try: from cuopt... except ImportError: ...`) and expose the dep as an opt-in `[<extra>]` extra in `pyproject.toml`. Document that users on the non-default CUDA major must pip-install the matching suffixed wheel themselves rather than relying on the extra. The conda recipe can still depend on the unsuffixed sibling, since conda doesn't have the suffix conflict. |
| Skill validation | Missing frontmatter or version mismatch | Run `./ci/utils/validate_skills.sh` locally to diagnose |

For CI scripts and pipeline details, see [ci/README.md](../../../ci/README.md).

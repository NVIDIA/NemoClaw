# Eval guidance for cudaq-guide

Developer guidance for generating and refining `evals.json`. This outranks
generated defaults during NV-BASE/NV-ACES generation and refinement.

## Questions

- How do I install CUDA-Q and confirm it works?
- Write and run a minimal CUDA-Q program to verify my setup.
- Which simulation target should I use for a circuit too large for one GPU?
- How do I run a CUDA-Q kernel on real QPU hardware from a given provider?
- How do I run many independent circuits in parallel across multiple GPUs?
- What applications can I build with CUDA-Q?
- (negative) Unrelated creative or general-programming requests.
- (negative) Near-miss prompts that mention CUDA or "install" but are not about
  CUDA-Q (e.g. installing PyTorch with CUDA), to guard against over-routing.

## Behaviors

- The agent read skills/cudaq-guide/SKILL.md before acting.
- The agent recommended the documented target/option for the scenario
  (`nvidia`, `nvidia --target-option mgpu`/`mqpu`, `qpp-cpu`, `tensornet`).
- The agent followed the documented workflow (e.g. validate install with the
  Bell state example; for QPU, identify the provider technology and advise
  `emulate=True` before real hardware).

## Notes

- cudaq-guide is a documentation/onboarding skill with **no executable script**,
  so `expected_script` is `null` for every case and the agent should never run
  a script.
- Ground truth is intentionally derived from SKILL.md content (the GPU target
  table, QPU two-step dialogue, parallelize mgpu/mqpu guidance), so cases remain
  answerable in an isolated workspace without staging the repo's docs/sphinx
  `.rst` files.
- Keep the CI-gated dataset small (P0 smoke) for the 1-hour NV-CARPS limit.
  Deeper, doc-reading cases that require staging `docs/sphinx/**` can follow once
  the publish path is stable (would need `skill_workspace.mode: group` or
  fixtures under `evals/files/`).
- Negative cases set `expected_skill: null` and `should_trigger: false`.

# Setup GPU environment, Git branch, and Docker container
Work with user to prepare the experiment environment:
1. Get UUID of GPU(s) available on current node:
   ```bash
   nvidia-smi -L
   # Output: GPU 0: NVIDIA B200 (UUID: GPU-d8ea7ef9-442e-488f-bd23-d6912699e32d)
   ```
   If no GPU available, break and ask user instructions for accessing GPU nodes
2. Create a fresh git branch: Propose a branch name, e.g., `auto-kernel-<transformer model name>-20260403` from target Transformer model ID and current date. The git branch `<user name>/experiment/<branch name>` must not exist. Checkout from current branch `git checkout -b <user name>/experiment/<branch name>`
3. Build Docker container for our experiment:
   ```bash
   # Build with source
   cd /path/to/project
   docker build --target source -f modeling/transformers/Dockerfile -t auto-kernel:latest .
   ```
4. Run all subsequent commands **inside this Docker container**. Do not substitute a host conda/venv. Only use a non-Docker environment if the user explicitly requests it.
   ```bash
   # Use the UUID from nvidia-smi -L output in step 1
   docker run --rm --gpus "device=GPU-d8ea7ef9-442e-488f-bd23-d6912699e32d" \
     -v /path/to/project:/workspace/tilegym \
     auto-kernel:latest \
     <command>
   ```
   Never use: `--gpus all` (potential multi-tenant conflicts) or `--gpus 0` (device index, not UUID)
5. Check these tools exist inside Docker container:
   1. `nvidia-smi -L` prints same UUID as in step 1
   2. `cuda.tile` (cuTile in subsequent context) is installed
   3. `nsys` and `ncu` CLI available
   4. `tileiras` and `ptxas` available and versions match with each other

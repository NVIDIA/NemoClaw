#!/bin/bash
# Detect conda even when not on PATH (lazy-init shells, non-default install dirs).
# Outputs:
#   ✓ conda found: <version> at <path>
#   (optional) additional installs on extra lines
#   --- envs ---
#   <env list from each install>
#   --- holoscan envs ---
#   <envs whose python imports holoscan, with version>
# OR:
#   ✗ conda not installed (checked PATH, common install dirs, and shell rc files)

set -u

found_paths=()

# 1) Already on PATH?
if command -v conda >/dev/null 2>&1; then
    p=$(command -v conda)
    # Resolve symlinks to the real install
    real=$(readlink -f "$p")
    found_paths+=("$real")
fi

# 2) Common install locations
for dir in \
    "$HOME/miniconda3" "$HOME/anaconda3" "$HOME/miniforge3" "$HOME/mambaforge" \
    "/opt/conda" "/opt/miniconda3" "/opt/anaconda3" "/opt/miniforge3"; do
    if [ -x "$dir/bin/conda" ]; then
        found_paths+=("$dir/bin/conda")
    fi
done

# 3) Shell rc files — catches custom install paths and lazy-init wrappers
for rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile" "$HOME/.bash_profile" "$HOME/.zprofile"; do
    [ -f "$rc" ] || continue
    while IFS= read -r match; do
        # Extract any /path/to/conda mentions
        cand=$(echo "$match" | grep -oE "[^ '\"]*/bin/conda" | head -1)
        if [ -n "$cand" ] && [ -x "$cand" ]; then
            found_paths+=("$cand")
        fi
    done < <(grep -E "conda" "$rc" 2>/dev/null)
done

# Deduplicate
if [ ${#found_paths[@]} -gt 0 ]; then
    mapfile -t found_paths < <(printf "%s\n" "${found_paths[@]}" | awk '!seen[$0]++')
fi

if [ ${#found_paths[@]} -eq 0 ]; then
    echo "✗ conda not installed (checked PATH, common install dirs, and shell rc files)"
    exit 0
fi

# Report each install
for cbin in "${found_paths[@]}"; do
    ver=$("$cbin" --version 2>/dev/null || echo "unknown")
    echo "✓ conda found: $ver at $cbin"
done

# Note if not on PATH despite being installed (lazy-init scenario)
if ! command -v conda >/dev/null 2>&1; then
    echo "  (note: conda is installed but not on PATH in the current shell — likely lazy-loaded via a shell function or only initialized in another rc file)"
fi

echo "--- envs ---"
for cbin in "${found_paths[@]}"; do
    echo "[$cbin]"
    "$cbin" env list 2>/dev/null | grep -v "^#" | grep -v "^$"
done

echo "--- holoscan envs ---"
for cbin in "${found_paths[@]}"; do
    # Get env paths (column 2 if active marker, else column 1's last field)
    "$cbin" env list 2>/dev/null | grep -v "^#" | awk 'NF>=2 {print $NF}' | while read -r envpath; do
        py="$envpath/bin/python"
        [ -x "$py" ] || continue
        out=$("$py" -c "import holoscan; print(holoscan.__version__)" 2>/dev/null)
        if [ -n "$out" ]; then
            echo "  $envpath → holoscan $out"
        fi
    done
done

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Python entrypoint kept separate from parsing, ownership, and replacement helpers. */
export const KEY_ALLOWLIST_ENTRYPOINT_PYTHON = String.raw`
def main():
    if len(sys.argv) != 4:
        fail("expected a config base, relative path, and ownership spec")
    base_dir, relative_path, spec_raw = sys.argv[1:]
    spec = load_spec(spec_raw)
    _backup_text, backup = read_stdin_config("backed-up")
    parent_fd, current_name = open_config_parent(base_dir, relative_path)
    try:
        current_text, current, current_metadata = read_regular_file_at(
            parent_fd, current_name, "current"
        )
        header_lines = preserved_headers(current_text, spec.get("require_fresh_headers", []))
        assert_fresh_tables(current, spec.get("require_fresh_tables", []))
        merged = merge_user_keys(backup, current, spec.get("user_keys", []))
        payload = render_merged_config(merged, header_lines)
        write_staged_and_replace(parent_fd, current_name, current_metadata, payload)
    finally:
        os.close(parent_fd)


main()
`.trim();

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Python entrypoint kept separate from parsing, ownership, and replacement helpers. */
export const KEY_ALLOWLIST_ENTRYPOINT_PYTHON = String.raw`
def main():
    if len(sys.argv) != 4:
        fail("expected a config base, relative path, and ownership spec")
    base_dir, relative_path, spec_raw = sys.argv[1:]
    spec = load_spec(spec_raw)
    config_format = spec.get("format")
    allow_missing = spec.get("allow_missing_fresh")
    file_mode = spec.get("file_mode")
    if config_format not in ("json", "toml"):
        fail("restore ownership spec has an invalid config format")
    if not isinstance(allow_missing, bool):
        fail("restore ownership spec has an invalid missing-fresh setting")
    if file_mode not in (0o600, 0o660):
        fail("restore ownership spec has an invalid file mode")
    if allow_missing and (
        config_format != "json"
        or spec.get("require_fresh_tables", [])
        or spec.get("require_fresh_headers", [])
    ):
        fail("missing fresh config is incompatible with managed fresh requirements")
    _backup_text, backup = read_stdin_config("backed-up", config_format)
    parent_fd, current_name = open_config_parent(base_dir, relative_path)
    try:
        current_text, current, current_metadata = read_regular_file_at(
            parent_fd, current_name, "current", config_format, allow_missing
        )
        header_lines = preserved_headers(current_text, spec.get("require_fresh_headers", []))
        assert_fresh_tables(current, spec.get("require_fresh_tables", []))
        merged = merge_user_keys(backup, current, spec.get("user_keys", []))
        payload = render_merged_config(merged, header_lines, config_format)
        write_staged_and_replace(parent_fd, current_name, current_metadata, payload, file_mode)
    finally:
        os.close(parent_fd)


main()
`.trim();

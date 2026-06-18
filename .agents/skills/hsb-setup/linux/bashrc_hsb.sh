#!/usr/bin/env bash
# HSB convenience function for bash.
# Add this to your ~/.bashrc:
#   source "$HOME/.claude/skills/hsb-setup-skill/linux/bashrc_hsb.sh"
#
# Then type 'hsb' in any terminal to pick a profile and launch Claude Code.

hsb() {
    local skill_path="$HOME/.claude/skills/hsb-setup-skill/linux"
    local profile_dir="$skill_path/profiles"

    if [[ ! -d "$skill_path" ]]; then
        echo -e "\033[31mSkill path not found: $skill_path\033[0m"
        return 1
    fi

    if [[ ! -d "$profile_dir" ]]; then
        echo -e "\033[31mProfiles directory not found: $profile_dir\033[0m"
        return 1
    fi

    local profiles=()
    for f in "$profile_dir"/*-env.sh; do
        [[ -f "$f" ]] || continue
        [[ "$(basename "$f")" == "example-env.sh" ]] && continue
        profiles+=("$f")
    done
    IFS=$'\n' profiles=($(printf '%s\n' "${profiles[@]}" | sort)); unset IFS

    if [[ ${#profiles[@]} -eq 0 ]]; then
        echo -e "\033[31mNo environment profiles found in $profile_dir\033[0m"
        echo -e "\033[33mCreate one by copying profiles/example-env.sh to profiles/<name>-env.sh\033[0m"
        return 1
    fi

    echo ""
    echo -e "  \033[36mHSB Environment Profiles\033[0m"
    echo -e "  \033[36m========================\033[0m"
    echo ""

    local i
    for i in "${!profiles[@]}"; do
        local file="${profiles[$i]}"
        local name
        name="$(basename "$file" .sh)"
        name="${name%-env}"

        local target="" platform="" preview=""
        target="$(grep -m1 '^export SSH_TARGET=' "$file" | sed "s/^export SSH_TARGET='\\([^']*\\)'.*/\\1/")"
        platform="$(grep -m1 '^export HSB_PLATFORM=' "$file" | sed "s/^export HSB_PLATFORM='\\([^']*\\)'.*/\\1/")"
        [[ -n "$target" ]] && preview="$target"
        [[ -n "$platform" ]] && preview="$preview ($platform)"

        if [[ -n "$preview" ]]; then
            printf "  \033[32m[%d] %s\033[0m  -  \033[90m%s\033[0m\n" "$((i + 1))" "$name" "$preview"
        else
            printf "  \033[32m[%d] %s\033[0m\n" "$((i + 1))" "$name"
        fi
    done

    echo ""
    local choice
    read -rp "  Select profile [1-${#profiles[@]}]: " choice

    if ! [[ "$choice" =~ ^[0-9]+$ ]]; then
        echo -e "\033[31mInvalid selection.\033[0m"
        return 1
    fi

    local idx=$((choice - 1))
    if (( idx < 0 || idx >= ${#profiles[@]} )); then
        echo -e "\033[31mSelection out of range.\033[0m"
        return 1
    fi

    local selected="${profiles[$idx]}"
    local profile_name
    profile_name="$(basename "$selected" .sh)"
    profile_name="${profile_name%-env}"

    cd "$skill_path" || return 1
    echo ""
    source "$skill_path/set-hsb-env.sh" "$profile_name"

    if [[ -z "$SSH_TARGET" ]]; then
        echo -e "\033[31mFailed to load environment variables.\033[0m"
        return 1
    fi

    echo -e "\033[36mLaunching Claude...\033[0m"
    claude
}

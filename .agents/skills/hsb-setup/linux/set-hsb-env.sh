#!/usr/bin/env bash
# Profile loader for HSB environment profiles.
# Usage: source set-hsb-env.sh <profile-name>
#
# This script must be sourced (not executed) so that exported
# variables are available in the calling shell.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE_DIR="$SCRIPT_DIR/profiles"

profile="$1"

if [[ -z "$profile" ]]; then
    echo -e "\033[36mAvailable HSB profiles:\033[0m"
    found=false
    if [[ -d "$PROFILE_DIR" ]]; then
        for f in "$PROFILE_DIR"/*-env.sh; do
            [[ -f "$f" ]] || continue
            name="$(basename "$f" .sh)"
            name="${name%-env}"
            echo "  $name"
            found=true
        done
    fi
    if [[ "$found" == false ]]; then
        echo "  (none found)"
        echo ""
        echo -e "\033[33mCreate a profile by copying profiles/example-env.sh to profiles/<name>-env.sh\033[0m"
    fi
    echo ""
    echo -e "\033[33mUsage:  source set-hsb-env.sh <name>\033[0m"
    return 0 2>/dev/null || exit 0
fi

config_file="$PROFILE_DIR/${profile}-env.sh"

if [[ ! -f "$config_file" ]]; then
    echo -e "\033[31mProfile not found: $config_file\033[0m" >&2
    echo "Create it by copying profiles/example-env.sh to profiles/${profile}-env.sh" >&2
    return 1 2>/dev/null || exit 1
fi

source "$config_file"

for var in SSH_TARGET REMOTE_ROOT; do
    if [[ -z "${!var}" ]]; then
        echo -e "\033[31mMissing required environment variable: $var\033[0m" >&2
        return 1 2>/dev/null || exit 1
    fi
done

echo -e "\033[32mLoaded HSB profile: $profile\033[0m"
echo "  SSH_TARGET  = $SSH_TARGET"
echo "  REMOTE_ROOT = $REMOTE_ROOT"
echo "  REMOTE_SUDO = $REMOTE_SUDO"
echo "  SSH_OPTS    = $REMOTE_SSH_OPTS"
echo "  PLATFORM    = $HSB_PLATFORM"
echo ""
echo "Start Claude Code in this same shell with: claude"

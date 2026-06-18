#!/bin/bash
# Usage: check_ngc_image.sh <tag-suffix>
# Example: check_ngc_image.sh cuda13
SUFFIX="${1:-cuda13}"
RESULT=$(docker images 2>/dev/null | grep "clara-holoscan/holoscan" | grep "$SUFFIX")
if [ -n "$RESULT" ]; then
    echo "✓ NGC container already pulled:"
    echo "$RESULT"
else
    echo "✗ No holoscan NGC image found for variant: $SUFFIX"
fi

#!/bin/bash

# Publish unpublished packages using 1Password for OTP.

NPM_1P_UUID="5d3vvm3lccvvdj5nsz4htzj56y"
NPM_1P_ACCOUNT="QFC3DYZ6MVCABC4NTFD2UN7P6A"
SLEEP_SECONDS=5
PACKAGES_FILE="${1:-unpublished-packages.txt}"

# Track results.
SUCCEEDED=()
FAILED=()

if [ ! -f "$PACKAGES_FILE" ]; then
  echo "Error: $PACKAGES_FILE not found"
  exit 1
fi

# Check if 1Password CLI is available.
if ! command -v op &> /dev/null; then
  echo "Error: 1Password CLI (op) not found. Install it from https://1password.com/downloads/command-line/"
  exit 1
fi

# Count packages.
TOTAL=$(wc -l < "$PACKAGES_FILE" | tr -d ' ')
echo "Publishing $TOTAL packages..."
echo ""

i=0
while read -r pkg; do
  i=$((i + 1))
  echo "=========================================="
  echo "[$i/$TOTAL] Publishing $pkg"
  echo "=========================================="

  # Get fresh OTP from 1Password.
  OTP=$(op item get "$NPM_1P_UUID" --otp --account "$NPM_1P_ACCOUNT")

  if [ -z "$OTP" ]; then
    echo "Error: Could not get OTP from 1Password"
    exit 1
  fi

  # Publish with OTP.
  if pnpm --filter "$pkg" publish --no-git-checks --access public --otp "$OTP"; then
    echo "✓ Successfully published $pkg"
    SUCCEEDED+=("$pkg")
  else
    echo "✗ Failed to publish $pkg"
    FAILED+=("$pkg")
  fi

  # Sleep between publishes to avoid rate limiting.
  if [ $i -lt $TOTAL ]; then
    echo "Waiting ${SLEEP_SECONDS}s before next publish..."
    sleep $SLEEP_SECONDS
  fi

  echo ""
done < "$PACKAGES_FILE"

echo "=========================================="
echo "SUMMARY"
echo "=========================================="
echo "Succeeded: ${#SUCCEEDED[@]}"
echo "Failed: ${#FAILED[@]}"

if [ ${#FAILED[@]} -gt 0 ]; then
  echo ""
  echo "Failed packages:"
  for pkg in "${FAILED[@]}"; do
    echo "  - $pkg"
  done
  echo ""
  echo "To retry failed packages, run:"
  echo "  printf '%s\n' ${FAILED[*]} > failed-packages.txt"
  echo "  ./tools/npm-trusted-publisher/publish-unpublished.sh failed-packages.txt"
fi

echo "=========================================="

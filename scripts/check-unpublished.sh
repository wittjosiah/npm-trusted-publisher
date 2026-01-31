#!/bin/bash

# Check which packages from the monorepo are not yet published to npm.

set -e

echo "Fetching list of publishable packages..."

# Get all packages that would be published.
PACKAGES=$(pnpm --filter-prod="./packages/**" --filter-prod="./vendor/**" list --json 2>/dev/null | jq -r '.[].name' | grep "^@dxos/" | sort)

TOTAL=$(echo "$PACKAGES" | wc -l | tr -d ' ')
echo "Found $TOTAL packages to check."
echo ""

UNPUBLISHED=()
PUBLISHED=()
ERRORS=()

i=0
for pkg in $PACKAGES; do
  i=$((i + 1))
  printf "\r[%d/%d] Checking %s...                    " "$i" "$TOTAL" "$pkg"

  # Check if package exists on npm.
  if npm view "$pkg" version &>/dev/null; then
    PUBLISHED+=("$pkg")
  else
    # Double-check with a different method.
    HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "https://registry.npmjs.org/$pkg")
    if [ "$HTTP_STATUS" = "404" ]; then
      UNPUBLISHED+=("$pkg")
    elif [ "$HTTP_STATUS" = "200" ]; then
      PUBLISHED+=("$pkg")
    else
      ERRORS+=("$pkg (HTTP $HTTP_STATUS)")
    fi
  fi
done

echo ""
echo ""
echo "============================================"
echo "RESULTS"
echo "============================================"
echo ""

echo "Published packages: ${#PUBLISHED[@]}"
echo "Unpublished packages: ${#UNPUBLISHED[@]}"
if [ ${#ERRORS[@]} -gt 0 ]; then
  echo "Errors: ${#ERRORS[@]}"
fi

echo ""

if [ ${#UNPUBLISHED[@]} -gt 0 ]; then
  echo "============================================"
  echo "UNPUBLISHED PACKAGES"
  echo "============================================"
  for pkg in "${UNPUBLISHED[@]}"; do
    echo "  $pkg"
  done

  echo ""
  echo "============================================"
  echo "TO PUBLISH THESE PACKAGES"
  echo "============================================"
  echo ""
  echo "Option 1: Publish all unpublished packages:"
  echo ""
  echo "  for pkg in ${UNPUBLISHED[*]}; do"
  echo '    pnpm --filter "$pkg" publish --no-git-checks --access public'
  echo "  done"
  echo ""
  echo "Option 2: Publish individually (run from package directory):"
  echo ""
  for pkg in "${UNPUBLISHED[@]}"; do
    # Find the package directory.
    PKG_DIR=$(find packages vendor -name "package.json" -exec grep -l "\"name\": \"$pkg\"" {} \; 2>/dev/null | head -1 | xargs dirname 2>/dev/null || echo "")
    if [ -n "$PKG_DIR" ]; then
      echo "  # $pkg"
      echo "  cd $PKG_DIR && pnpm publish --no-git-checks --access public && cd -"
      echo ""
    fi
  done

  # Save to file for easy use.
  echo ""
  echo "Saving unpublished package list to: unpublished-packages.txt"
  printf '%s\n' "${UNPUBLISHED[@]}" > unpublished-packages.txt
fi

if [ ${#ERRORS[@]} -gt 0 ]; then
  echo ""
  echo "============================================"
  echo "ERRORS (could not determine status)"
  echo "============================================"
  for err in "${ERRORS[@]}"; do
    echo "  $err"
  done
fi

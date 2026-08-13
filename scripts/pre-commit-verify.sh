#!/bin/sh
#
# Selector Healer - Pre-commit Hook
#
# Runs the fast `selector-healer check` command to detect selector drift
# before the commit goes through. No browser needed - just AST parsing
# and fingerprint comparison.
#
# Installation options:
#
#   Option A: Manual git hook
#     cp scripts/pre-commit-verify.sh .git/hooks/pre-commit
#     chmod +x .git/hooks/pre-commit
#
#   Option B: With husky (npm install -D husky)
#     npx husky add .husky/pre-commit "sh scripts/pre-commit-verify.sh"
#
#   Option C: With lint-staged (package.json)
#     "lint-staged": {
#       "tests/**/*.{ts,tsx}": "selector-healer check"
#     }
#

# Only run if test files are staged
STAGED_TEST_FILES=$(git diff --cached --name-only --diff-filter=ACM | grep -E '\.(spec|test)\.(ts|tsx|js|jsx)$' || true)

if [ -z "$STAGED_TEST_FILES" ]; then
  exit 0
fi

echo "🔍 Checking selector health..."

# Use the local CLI if available, otherwise try npx
if [ -f "node_modules/.bin/selector-healer" ]; then
  node_modules/.bin/selector-healer check
elif [ -f "packages/cli/dist/index.js" ]; then
  node packages/cli/dist/index.js check
else
  npx selector-healer check
fi

STATUS=$?

if [ $STATUS -ne 0 ]; then
  echo ""
  echo "❌ Selector drift detected. Run 'selector-healer capture' to update baselines."
  echo "   Use --no-verify to skip this check (not recommended)."
  exit 1
fi

echo "✅ Selector check passed."
exit 0

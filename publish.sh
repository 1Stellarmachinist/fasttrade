#!/usr/bin/env bash
# Publish fasttrade to GitHub in two commands.
#
# Prerequisites (once):
#   1. Create an EMPTY repo on github.com named "fasttrade" (public,
#      no README, no .gitignore, no licence).
#   2. Set it below.
#
# Then run:  bash publish.sh
#
set -euo pipefail

REPO_URL="https://github.com/YOUR-USERNAME/fasttrade.git"

cd "$(dirname "$0")"

echo "== repo state =="
git status --short
echo "branch: $(git branch --show-current)"
echo "commits: $(git rev-list --count HEAD)"
echo

if [ "$REPO_URL" = "https://github.com/YOUR-USERNAME/fasttrade.git" ]; then
  echo "!! Edit REPO_URL in this file first, or pass the URL as an argument:"
  echo "   bash publish.sh https://github.com/you/fasttrade.git"
  exit 1
fi

# allow the URL to be passed on the command line
if [ $# -ge 1 ]; then REPO_URL="$1"; fi

echo "== remote =="
if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "$REPO_URL"
else
  git remote add origin "$REPO_URL"
fi
git remote -v
echo

echo "== pushing =="
# first push may open a browser window for GitHub sign-in (Git Credential Manager)
git push -u origin main

echo
echo "done. open: ${REPO_URL%.git}"

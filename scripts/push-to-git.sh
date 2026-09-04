#!/bin/sh
set -eu

if [ "$#" -lt 1 ]; then
  echo "Usage: ./scripts/push-to-git.sh <git-repository-url>"
  echo "Example: ./scripts/push-to-git.sh git@github.com:YOUR_USER/garmin-rest-worker.git"
  exit 1
fi

REPO_URL="$1"

if ! command -v git >/dev/null 2>&1; then
  echo "git is required."
  exit 1
fi

if [ ! -d .git ]; then
  git init
fi

git add .

if ! git diff --cached --quiet; then
  git commit -m "Initial Garmin REST Cloudflare Worker"
fi

git branch -M main

if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "$REPO_URL"
else
  git remote add origin "$REPO_URL"
fi

git push -u origin main

echo ""
echo "✅ Pushed to: $REPO_URL"
echo "Next: connect the repo to Cloudflare Workers and configure KV + secrets."

#!/usr/bin/env bash
# Bump the version everywhere, commit, tag and push. The tag push triggers .github/workflows/release.yml.
# Usage: scripts/release.sh <version>   e.g. scripts/release.sh 0.2.0
set -euo pipefail

cd "$(dirname "$0")/.."

version="${1:-}"
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "usage: $0 <major.minor.patch>" >&2
  exit 1
fi
tag="v$version"

if [[ "$(git branch --show-current)" != "main" ]]; then
  echo "error: releases are cut from main" >&2
  exit 1
fi
if [[ -n "$(git status --porcelain)" ]]; then
  echo "error: working tree is not clean, commit or stash first" >&2
  exit 1
fi
if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
  echo "error: tag $tag already exists" >&2
  exit 1
fi

git pull --ff-only

npm version "$version" --no-git-tag-version --allow-same-version >/dev/null
sed -i.bak -E "s/^  \"version\": \"[^\"]+\"/  \"version\": \"$version\"/" src-tauri/tauri.conf.json
sed -i.bak -E "1,/^version = /s/^version = \"[^\"]+\"/version = \"$version\"/" src-tauri/Cargo.toml
rm -f src-tauri/tauri.conf.json.bak src-tauri/Cargo.toml.bak
cargo update --workspace --manifest-path src-tauri/Cargo.toml --quiet

git add package.json package-lock.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "Release $tag"
git tag "$tag"
git push origin main "$tag"

echo "Pushed $tag, the release workflow is building a release:"
echo "  https://github.com/janoschjost/houston/actions"

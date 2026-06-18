#!/usr/bin/env bash
# Sync skills from the synap-backend source-of-truth into this CLI package.
#
# Runs automatically before `npm publish` (see package.json `prepublishOnly`).
# The synced `skills/` directory is gitignored — it lives in the published
# npm tarball but not in the repo.
#
# Usage:
#   ./scripts/sync-skills.sh             (expects ../synap-backend/skills)
#   SYNAP_SKILLS_SOURCE=/path ./scripts/sync-skills.sh   (override)

set -euo pipefail

cd "$(dirname "$0")/.."
DEST="skills"

SRC="${SYNAP_SKILLS_SOURCE:-../synap-backend/skills}"

if [ ! -d "$SRC" ]; then
  echo "sync-skills: source not found at $SRC" >&2
  echo "  Set SYNAP_SKILLS_SOURCE to the folder containing synap/, synap-schema/, synap-ui/" >&2
  exit 1
fi

# Each package's SKILL.md is a GENERATED build artifact assembled from the topic
# source files (_skill.yaml + _order.txt + *.md). Regenerate it BEFORE copying so
# the published CLI tarball always ships a fresh, assembled SKILL.md per package.
if [ -f "$SRC/build.mjs" ]; then
  echo "  building SKILL.md from topic sources ..."
  node "$SRC/build.mjs" "$SRC"
fi

for name in synap synap-schema synap-ui; do
  if [ ! -f "$SRC/$name/SKILL.md" ]; then
    echo "sync-skills: missing skill $name at $SRC/$name/SKILL.md" >&2
    exit 1
  fi
done

rm -rf "$DEST"
mkdir -p "$DEST"

for name in synap synap-schema synap-ui; do
  cp -R "$SRC/$name" "$DEST/$name"
  echo "  synced $name"
done

# Copy the top-level README if present (useful context for consumers)
if [ -f "$SRC/README.md" ]; then
  cp "$SRC/README.md" "$DEST/README.md"
  echo "  synced README.md"
fi

echo "sync-skills: done ($DEST populated from $SRC)"

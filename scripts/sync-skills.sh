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

# Derive skill list from manifest.json (baseline ++ workflow)
if [ -f "$SRC/manifest.json" ]; then
  SKILL_LIST=$(node -e "
    const m = JSON.parse(require('fs').readFileSync('$SRC/manifest.json', 'utf8'));
    console.log([...(m.baseline||[]), ...(m.workflow||[])].join(' '));
  ")
else
  SKILL_LIST="synap synap-schema synap-ui onboard agent-os"
  echo "sync-skills: manifest.json not found at $SRC/manifest.json, using fallback list" >&2
fi

for name in $SKILL_LIST; do
  if [ ! -f "$SRC/$name/SKILL.md" ]; then
    echo "sync-skills: missing skill $name at $SRC/$name/SKILL.md" >&2
    exit 1
  fi
done

rm -rf "$DEST"
mkdir -p "$DEST"

# Copy manifest.json into the bundle so the published CLI can read it at runtime
if [ -f "$SRC/manifest.json" ]; then
  cp "$SRC/manifest.json" "$DEST/manifest.json"
  echo "  synced manifest.json"
fi

for name in $SKILL_LIST; do
  cp -R "$SRC/$name" "$DEST/$name"
  echo "  synced $name"
done

# Copy the top-level README if present (useful context for consumers)
if [ -f "$SRC/README.md" ]; then
  cp "$SRC/README.md" "$DEST/README.md"
  echo "  synced README.md"
fi

echo "sync-skills: done ($DEST populated from $SRC)"

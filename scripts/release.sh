#!/bin/sh
# Release script for opencode-rc
# Usage: ./scripts/release.sh [version]

set -eu

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
    echo "Usage: $0 <version>"
    echo "Example: $0 0.1.0"
    exit 1
fi

# Validate version format (semver)
if ! echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.-]+)?(\+[a-zA-Z0-9.-]+)?$'; then
    echo "Error: Invalid version format. Use semantic versioning (e.g., 0.1.0)"
    exit 1
fi

echo "Preparing release $VERSION..."

# Check working directory is clean
if [ -n "$(git status --porcelain)" ]; then
    echo "Error: Working directory is not clean. Commit or stash changes first."
    git status --short
    exit 1
fi

# Run full CI check
echo "Running CI checks..."
bun run check

# Update version in package.json files
echo "Updating version to $VERSION..."
for pkg in package.json packages/*/package.json; do
    if [ -f "$pkg" ]; then
        # Update version field
        sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" "$pkg"
    fi
done

# Update CHANGELOG.md with new version header
DATE=$(date +%Y-%m-%d)
sed -i "1s/.*/# Changelog\n\n## [$VERSION] - $DATE/" CHANGELOG.md

# Commit version bump
git add -A
git commit -m "chore: release v$VERSION"

# Create annotated tag
git tag -a "v$VERSION" -m "Release v$VERSION"

echo "Release $VERSION prepared successfully!"
echo ""
echo "To publish:"
echo "  git push origin main --tags"
echo ""
echo "Then create a GitHub release from the tag."
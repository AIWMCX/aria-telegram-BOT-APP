#!/usr/bin/env bash
# ARIA engine installer — macOS/Linux.
#
# Usage:
#   curl -fsSL https://aria-telegram-bot-app-production.up.railway.app/install.sh | bash
#
# Downloads the current released aria-engine bundle from this exact
# host (never a third-party mirror), verifies its sha256 against the
# published manifest, and installs it as a global `aria` command via
# `npm install -g` — no git clone, no manual npm/tsx setup, no .env
# editing. Requires Node.js >= 22.13.0 to already be present; this
# script does not install Node itself (silently modifying a user's
# system Node installation is out of scope for an engine installer).
set -euo pipefail

BASE_URL="https://aria-telegram-bot-app-production.up.railway.app"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

echo "ARIA engine installer"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js was not found on PATH." >&2
  echo "Install Node.js 22.13.0 or newer from https://nodejs.org/ and re-run this installer." >&2
  exit 1
fi

NODE_VERSION="$(node -e 'console.log(process.versions.node)')"
NODE_MAJOR="$(node -e 'console.log(process.versions.node.split(".")[0])')"
NODE_MINOR="$(node -e 'console.log(process.versions.node.split(".")[1])')"
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 13 ]; }; then
  echo "Node.js $NODE_VERSION was found, but ARIA requires >= 22.13.0." >&2
  echo "Install a newer Node.js from https://nodejs.org/ and re-run this installer." >&2
  exit 1
fi
echo "Node.js $NODE_VERSION found — OK"

if ! command -v npm >/dev/null 2>&1; then
  echo "npm was not found on PATH (it normally ships with Node.js). Reinstall Node.js from https://nodejs.org/ and re-run." >&2
  exit 1
fi

echo "Fetching release manifest..."
curl -fsSL "$BASE_URL/downloads/latest.json" -o "$WORKDIR/latest.json"
# Parsed with plain grep/sed, not `node -e` with an interpolated path —
# deliberately avoids any risk of Node's argument-parsing/path-resolution
# differing across shells and platforms; latest.json is our own flat,
# single-line-per-field JSON, so this is a safe, portable substitute for
# a real JSON parser here.
json_field() { grep -o "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "$WORKDIR/latest.json" | sed -E 's/.*:[[:space:]]*"([^"]*)"/\1/'; }
VERSION="$(json_field version)"
FILENAME="$(json_field filename)"
EXPECTED_SHA256="$(json_field sha256)"
if [ -z "$VERSION" ] || [ -z "$FILENAME" ] || [ -z "$EXPECTED_SHA256" ]; then
  echo "Could not parse the release manifest — it may be malformed. Aborting." >&2
  exit 1
fi
echo "Latest version: $VERSION"

echo "Downloading $FILENAME..."
curl -fsSL "$BASE_URL/downloads/$FILENAME" -o "$WORKDIR/$FILENAME"

echo "Verifying checksum..."
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL_SHA256="$(sha256sum "$WORKDIR/$FILENAME" | cut -d' ' -f1)"
elif command -v shasum >/dev/null 2>&1; then
  ACTUAL_SHA256="$(shasum -a 256 "$WORKDIR/$FILENAME" | cut -d' ' -f1)"
else
  echo "Neither sha256sum nor shasum is available — cannot verify the download's integrity." >&2
  exit 1
fi
if [ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]; then
  echo "Checksum mismatch! Expected $EXPECTED_SHA256, got $ACTUAL_SHA256." >&2
  echo "The download may be corrupted or tampered with. Aborting — nothing was installed." >&2
  exit 1
fi
echo "Checksum verified — OK"

echo "Installing ARIA globally (npm install -g)..."
npm install -g "$WORKDIR/$FILENAME"

echo
echo "ARIA $VERSION installed."
echo "Next steps:"
echo "  aria doctor           # check your setup"
echo "  aria pair <CODE>      # pair with your Telegram account (get a code from the ARIA Mini App)"
echo "  aria paper start      # start the paper trading engine"

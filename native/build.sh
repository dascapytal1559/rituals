#!/bin/sh
set -eu
umask 077
if [ "$#" -ne 2 ]; then echo 'Usage: build.sh OUTPUT_APP_PATH STORE_ROOT' >&2; exit 2; fi
RITUAL_NATIVE_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RITUAL_BUILD_APP=$1
RITUAL_STORE_ROOT=$2
if [ -e "$RITUAL_BUILD_APP" ]; then echo 'Output already exists' >&2; exit 2; fi
case "$RITUAL_STORE_ROOT" in /*) ;; *) echo 'STORE_ROOT must be an absolute path' >&2; exit 2 ;; esac
if [ ! -f "$RITUAL_STORE_ROOT/bin/ritual-server" ]; then echo 'STORE_ROOT is not a ritual store folder' >&2; exit 2; fi
if [ ! -f "$RITUAL_STORE_ROOT/config/node" ]; then echo 'STORE_ROOT/config/node is missing: write the absolute path of a Node.js 24 binary to it first (HANDOFF.md)' >&2; exit 2; fi
mkdir -p "$RITUAL_BUILD_APP/Contents/MacOS"
cp "$RITUAL_NATIVE_ROOT/Info.plist" "$RITUAL_BUILD_APP/Contents/Info.plist"
plutil -insert RitualStoreRoot -string "$RITUAL_STORE_ROOT" "$RITUAL_BUILD_APP/Contents/Info.plist"
xcrun clang -fobjc-arc -Wall -Wextra -mmacosx-version-min=13.0 -framework Cocoa "$RITUAL_NATIVE_ROOT/main.m" -o "$RITUAL_BUILD_APP/Contents/MacOS/RitualDashboard"
codesign --force --sign - --identifier local.ritual-dashboard.host "$RITUAL_BUILD_APP"
codesign --verify --strict "$RITUAL_BUILD_APP"

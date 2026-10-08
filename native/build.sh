#!/bin/sh
set -eu
umask 077
if [ "$#" -ne 3 ]; then echo 'Usage: build.sh OUTPUT_APP_PATH STORE_ROOT NODE' >&2; exit 2; fi
RITUAL_NATIVE_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RITUAL_BUILD_APP=$1
RITUAL_STORE_ROOT=$2
RITUAL_NODE=$3
if [ -e "$RITUAL_BUILD_APP" ]; then echo 'Output already exists' >&2; exit 2; fi
case "$RITUAL_STORE_ROOT" in /*) ;; *) echo 'STORE_ROOT must be an absolute path' >&2; exit 2 ;; esac
if [ ! -f "$RITUAL_STORE_ROOT/bin/ritual-server" ]; then echo 'STORE_ROOT is not a ritual store folder' >&2; exit 2; fi
case "$RITUAL_NODE" in /*) ;; *) echo 'NODE must be the absolute path of a Node.js 24 binary' >&2; exit 2 ;; esac
if [ ! -x "$RITUAL_NODE" ]; then echo 'NODE is not an executable file' >&2; exit 2; fi
case "$("$RITUAL_NODE" --version)" in v2[4-9].*|v[3-9][0-9].*) ;; *) echo 'NODE must be Node.js 24 or later' >&2; exit 2 ;; esac
mkdir -p "$RITUAL_BUILD_APP/Contents/MacOS"
cp "$RITUAL_NATIVE_ROOT/Info.plist" "$RITUAL_BUILD_APP/Contents/Info.plist"
plutil -insert RitualStoreRoot -string "$RITUAL_STORE_ROOT" "$RITUAL_BUILD_APP/Contents/Info.plist"
plutil -insert RitualNode -string "$RITUAL_NODE" "$RITUAL_BUILD_APP/Contents/Info.plist"
xcrun clang -fobjc-arc -Wall -Wextra -mmacosx-version-min=13.0 -framework Cocoa "$RITUAL_NATIVE_ROOT/main.m" -o "$RITUAL_BUILD_APP/Contents/MacOS/RitualDashboard"
codesign --force --sign - --identifier local.ritual-dashboard.host "$RITUAL_BUILD_APP"
codesign --verify --strict "$RITUAL_BUILD_APP"

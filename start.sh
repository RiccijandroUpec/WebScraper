#!/bin/sh
set -e
Xvfb :99 -screen 0 1366x900x24 -nolisten tcp &
export DISPLAY=:99
sleep 1
exec node server.js

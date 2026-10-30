#!/bin/sh
# Validate the independent app-login gate, then make the Node supervisor PID 1.
# The supervisor starts tailscaled and the Unix-socket-only Next origin, applies
# Tailscale Serve, verifies structured Serve state, and stops both children together.
set -eu

: "${GLOSS_OWNER_PASSWORD_HASH:?set GLOSS_OWNER_PASSWORD_HASH (fly secrets set)}"
exec node /app/deploy/supervisor.mjs

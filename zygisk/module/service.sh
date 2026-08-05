#!/system/bin/sh

# Extract the directory path and change directory 
MODDIR="${0%/*}"
cd "$MODDIR" || exit 1

# Keep recovery state outside the rotating log/cache directories. The native loader reads this
# marker before daemon IPC exists, so never delete /data/adb/lspd wholesale here.
mkdir -p /data/adb/lspd/safety 2>/dev/null || true

# Start the daemon directly in the background within a private mount namespace
unshare --propagation slave -m "$MODDIR/daemon" --system-server-max-retry=3 "$@" &

#!/system/bin/sh

# Preserve an emergency marker across uninstall. It is harmless while Vector is absent and lets a
# later reinstall remain disabled until the operator explicitly clears recovery mode.
RECOVERY_TMP="/data/adb/vector-safety-recovery"
if [ -f /data/adb/lspd/safety/disable ]; then
    cp -f /data/adb/lspd/safety/disable "$RECOVERY_TMP" 2>/dev/null || true
fi

rm -rf /data/adb/lspd

if [ -f "$RECOVERY_TMP" ]; then
    mkdir -p /data/adb/lspd/safety
    mv -f "$RECOVERY_TMP" /data/adb/lspd/safety/disable
    chmod 600 /data/adb/lspd/safety/disable
fi

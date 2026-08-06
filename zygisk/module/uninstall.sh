#!/system/bin/sh

# The daemon stages module native libraries under a randomized /data/misc directory. Keep a
# validated marker under /data/adb/lspd so uninstall can remove that directory before deleting the
# framework state, even when the device is not rebooted first.
MISC_PATH_MARKER="/data/adb/lspd/misc_path"
if [ -f "$MISC_PATH_MARKER" ]; then
    MISC_PATH=$(cat "$MISC_PATH_MARKER" 2>/dev/null)
    case "$MISC_PATH" in
        /data/misc/*)
            RELATIVE_PATH=${MISC_PATH#/data/misc/}
            case "$RELATIVE_PATH" in
                ""|"."|".."|*/*) MISC_PATH="" ;;
            esac
            ;;
        *) MISC_PATH="" ;;
    esac
    [ -n "$MISC_PATH" ] && rm -rf -- "$MISC_PATH"
fi

rm -rf -- /data/adb/lspd

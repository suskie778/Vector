# Vector recovery and emergency disable

Vector has a pre-injection circuit breaker at:

```text
/data/adb/lspd/safety/disable
```

When that file exists, the native Zygisk loader skips both application and
`system_server` injection before opening the daemon binder or installing ART/JNI
hooks. It does not remove hooks from processes that are already running; reboot
or restart the affected processes after enabling it.

## ADB recovery

If the manager or daemon cannot start, use a root shell:

```sh
mkdir -p /data/adb/lspd/safety
printf 'manual adb recovery\n' > /data/adb/lspd/safety/disable
chmod 600 /data/adb/lspd/safety/disable
reboot
```

After repairing or removing the offending module, clear the marker explicitly:

```sh
rm -f /data/adb/lspd/safety/disable
reboot
```

## CLI

When the daemon is reachable:

```sh
/data/adb/lspd/cli safety status
/data/adb/lspd/cli safety enable
/data/adb/lspd/cli safety disable
```

The daemon also records boot and `system_server` failure state in
`/data/adb/lspd/safety/boot.properties`. Repeated failures enable the marker
automatically. A successful framework handshake marks the boot healthy.
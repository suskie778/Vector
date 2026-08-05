---
name: Xiaomi unlock worker
description: Durable constraints for optimizing the public Xiaomi unlock-flow worker.
---

The extracted `crypto-util` bundle is a minified CryptoJS implementation of
AES-CBC/PKCS#7, SHA-1, HMAC-SHA1, and MD5. It is not an alternate unlock
endpoint and does not remove Xiaomi authorization requirements.

**Why:** The worker's safe performance gains are in reducing repeated Web
Crypto setup and avoidable request latency, not in changing Xiaomi's signed
request or eligibility protocol.

**How to apply:** Preserve official browser-session exchange, service-token
validation, account/device eligibility, waiting-period responses, device-token
requirements, and local fastboot steps when making future optimizations.

Google Colab can test the official account/session and Worker responses, but it
cannot see a USB phone attached to a separate service computer. Keep fastboot
device-token collection and any local destructive command on the service PC.

**Why:** Separating remote account checks from local USB operations avoids
mistaking a successful login test for a complete phone-unlock test.

**How to apply:** Use the Colab smoke test through `/api/session` and
`/api/userinfo`; use `Fastboot.mjs` on the machine that physically has the
phone connected.
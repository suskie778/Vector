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
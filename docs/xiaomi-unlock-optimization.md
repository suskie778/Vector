# Xiaomi unlock worker optimization notes

The public `xiaomi_frontend_extracted.zip` was inspected, including
`crypto-util.7ebfad42.js`. That bundle is a minified CryptoJS build containing
the primitives used by the browser application: AES-CBC with PKCS#7 padding,
SHA-1, HMAC-SHA1, and MD5. It does not provide a second unlock endpoint or a
way to omit Xiaomi authorization.

The optimized worker is
`scripts/src/unlock-mi-easier.optimized.js`. It preserves the public worker's
routes and request shapes:

- `POST /api/session`
- `POST /api/userinfo`
- `POST /api/nonce`
- `POST /api/clear`
- `POST /api/unlock`
- `POST /api/unlock/download`

## Changes made

1. The same `ssecurity` bytes are decoded once when a session is normalized.
2. The AES key is imported once per signed request instead of once per field.
3. Independent AES operations for `sign` and encrypted parameters run with
   `Promise.all`, while their original sorted parameter order is preserved.
4. The constant HMAC signing key is imported once per Worker isolate.
5. The MD5 value used for `pcId` is bounded-cached by device ID.
6. Outbound account and unlock requests have a 15-second timeout, preventing
   hung upstream calls from occupying a worker indefinitely.

The official login/session exchange, service-token requirement, device-token
requirement, account eligibility response, waiting periods, and local
fastboot steps remain unchanged.

Source reference:
<https://github.com/suskie778/Extract_endpoints4htmls>

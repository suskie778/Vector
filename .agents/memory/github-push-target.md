---
name: GitHub push target
description: Repository ownership and force-push verification rule
---

Always verify the authenticated GitHub account and the exact repository URL before pushing. A
valid token can still be denied when the remote belongs to another owner, and a force push must
only target the repository explicitly confirmed by the user.

**Why:** Repository remotes can come from an upstream project or an internal backup, while the
user may intend to publish to a fork under their own account.

**How to apply:** Check the remote owner, authenticated identity, current branch, and remote SHA
before and after a force push. Never expose the token in commands or output.
# Security Policy

## Supported versions

Only the latest release of SwarmCast receives security fixes. Please update to the newest
version (the start scripts can do it for you) before reporting an issue.

| Version        | Supported |
| -------------- | --------- |
| Latest release | Yes       |
| Older releases | No        |

## Reporting a vulnerability

Please do **not** open a public issue, discussion or pull request for security problems.

Report them privately through GitHub's security advisories:

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability**
   (direct link: <https://github.com/Lucas-Angelo/swarmcast/security/advisories/new>).
3. Describe the issue, the affected version and operating system, and the steps to
   reproduce it. A proof of concept, logs or a suggested fix help a lot.

You can expect an acknowledgement within a few days. Once the issue is confirmed, a fix is
prepared in a private fork, released, and the advisory is published with credit to you
(unless you prefer to stay anonymous). Please keep the details private until the fix is out.

## Scope

In scope, for example:

- Access control: watching a stream without a valid members-only link, using an old link
  after a new one was generated, bypassing a kick, or impersonating another viewer.
- Integrity: making viewers play segments that do not match the signed SHA-256 manifest,
  or injecting data through the viewer-to-viewer (P2P) swarm.
- The local admin panel (bound to `127.0.0.1`): reaching it from another machine or
  website (CSRF, DNS rebinding, missing authentication) or taking over the host.
- Leaks of secrets such as the stream key, admin token or signing keys, or of viewers'
  information beyond what the feature requires.
- The release and update pipeline: tampering with downloads, checksums or the start scripts.

Out of scope:

- Vulnerabilities in third-party software SwarmCast runs (MediaMTX, cloudflared, Node.js,
  browsers, OBS); please report those upstream. We do want to hear about them if SwarmCast
  ships a vulnerable version, so we can update the pinned release.
- Members of a stream re-sharing what they watch (screen recording, re-streaming): a
  members-only link limits who can connect, it is not DRM.
- Viewers' IP addresses being visible to other viewers when P2P is enabled; this is
  inherent to WebRTC and P2P can be turned off.
- Denial of service that requires bandwidth comparable to the host's own connection.
- Issues that need an already compromised host machine or administrator account.

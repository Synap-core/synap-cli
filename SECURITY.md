# Security policy

## Reporting a vulnerability

Please report security problems privately, by email to
**security@synap.live**. Do not open a public issue or pull request for them.

Include what you can of:

- the command and the CLI version (`synap --version`), and your operating
  system,
- the steps to reproduce, or a proof of concept,
- the impact you expect (an API key or session token written where another
  user or process can read it, a key sent to the wrong pod, code run from an
  untrusted template, and so on).

We will acknowledge the report, keep you informed while we work on it, and
credit you in the fix unless you ask us not to. Please give us a reasonable
time to release a fix before you disclose the problem publicly.

## Supported versions

Fixes are made on `main` and shipped in the next npm release of
`@synap-core/cli`. Update with `npm install -g @synap-core/cli@latest`. Older
versions are not patched separately.

## Scope

This policy covers the code in this repository: the `synap` command, the
configuration and key files it writes, and the files it installs into agent
clients. Problems in the pod itself belong to
[Synap-core/backend](https://github.com/Synap-core/backend), which has its own
security policy and uses the same address.

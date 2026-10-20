# Contributing to the Synap CLI

Thank you for helping. This file covers working on `@synap-core/cli` (the
`synap` command): setting it up, running the checks CI runs, and sending a
change.

- Found a security problem? Do not open an issue: see [SECURITY.md](SECURITY.md).
- For a large change, open an issue first so the approach can be agreed before
  you write it.

## Requirements

- **Node.js 20 or later** (`engines` in `package.json`). CI builds, tests and
  publishes on Node 22.18.
- **npm.** The CLI is a plain npm package.
- **A checkout of [Synap-core/backend](https://github.com/Synap-core/backend)
  next to this one, as `../synap-backend`**, for two things: the agent skills
  the CLI ships (`npm run sync-skills` copies `../synap-backend/skills`), and one
  test that reads the pod's automation executor.

## Set up

```bash
git clone https://github.com/Synap-core/synap-cli.git
git clone https://github.com/Synap-core/backend.git synap-backend
cd synap-cli
npm install
```

Use `npm install`, not `npm ci`: the committed `package-lock.json` lags
`package.json`, and `npm ci` refuses the mismatch. Do not commit the lockfile
changes `npm install` makes unless your change is about dependencies.

## Repository layout

| Path                 | What it holds                                                          |
| -------------------- | ---------------------------------------------------------------------- |
| `src/index.ts`       | The entry point: builds the commander tree of every command            |
| `src/commands/`      | One file per command or command group                                  |
| `src/lib/`           | Shared code: pod and key handling, agent connections, the Hub client   |
| `test/`              | Vitest tests (some tests also sit next to their source in `src/`)      |
| `templates/`         | Templates the CLI installs or scaffolds (skills, automations)          |
| `docs/reference/`    | `cli.json` and `cli.md`, generated from the command tree               |
| `scripts/`           | Build info, skill sync, artifact verification, reference generator     |

Code comments sometimes cite an internal plan by name, for example
`APP-CONNECT-SPEC §5` or `MACHINE-IDENTITY-PLAN W4`. Those plans are not files
in this repository or any other: the Synap team keeps them in its own pod
(`synap ask "<plan name>"`). The comment itself should say what the code does.

## The checks

Run these before you open a pull request. The first four are the checks the
publish workflow runs, in the same order; the last is the `CLI reference`
workflow.

```bash
npx tsc --noEmit         # typecheck
npm run sync-skills      # copy ../synap-backend/skills into skills/ (gitignored)
npm test                 # vitest run
npm run build            # tsc into dist/, then write the build info
npm run docs:cli:check   # docs/reference/ matches the command tree
```

`npm run sync-skills` reads `SYNAP_SKILLS_SOURCE` instead of
`../synap-backend/skills` when it is set.

To try a command without building, run the source with `tsx`:

```bash
npm run dev -- status
```

## The CLI reference

`docs/reference/cli.json` and `cli.md` are generated from the commander tree
in `src/index.ts`, and the documentation site builds its CLI reference page
from `cli.json`. When you add, rename or remove a command or an option, or
change its description, regenerate and commit both files:

```bash
npm run docs:cli
```

The `CLI reference` workflow (`.github/workflows/cli-reference.yml`) fails a
pull request whose committed reference differs from the code.

## Commits

Commit subjects follow [Conventional Commits](https://www.conventionalcommits.org/)
with a scope, as in the existing history:

```
fix(connect): a failed check reads "could not confirm", never "not connected"
feat(cli): show the build's commit in --version, doctor and status
docs(readme): match config file, login and logout to the code
```

Common types are `feat`, `fix`, `test`, `docs`, `ci` and `chore`. The subject
says what the change does for the person running the CLI, in the present
tense. Keep one logical change per commit, and add a test with every fix.

## Releases

Releases are made by maintainers. The `Publish CLI` workflow
(`.github/workflows/publish-cli.yml`) is started by hand (`workflow_dispatch`)
and never runs on merge. It typechecks, syncs the skills, tests and builds,
bumps the patch version and pushes that commit, checks the packed artifact,
publishes to npm with provenance, then installs the published version and
runs it. Do not bump the version in a pull request.

## License

By contributing, you agree that your contribution is licensed under the MIT
license, as the package is (`license` in `package.json`).

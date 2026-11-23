# AGENTS.md

## Overview

Markdown backlog manager (CLI, Pi extension and `/backlog` TUI). Read `README.md` first for usage, install and the file format.

- `src/lib/backlog.ts`: core parse/serialize logic and `BacklogManager`.
- `src/cli/backlog-cli.ts`: the `pi-backlog` CLI.
- `extensions/backlog.ts`: Pi extension (`backlog_manage` tool and `/backlog` TUI).

## Commands

- `npm test`: run unit tests.
- `npm run build`: bundle the CLI to `dist/` (gitignored, do not commit).
- `npm run backlog -- <command>`: run the CLI from source.

## Rules

- Never touch the real `~/wiki/backlog.md` in tests or demos. Use `PI_BACKLOG_PATH` or `--file` with a temp file.
- Run `npm test` before committing.
- When you change CLI options or the file format, update `README.md` and the tool description in `extensions/backlog.ts` too.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/): `<type>(<optional scope>): <description>`.

- Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `build`, `ci`, `perf`, `style`.
- Description: imperative mood, lower case, no trailing period, about 72 characters or fewer.
- Breaking change: add `!` after the type or scope (`feat!: ...`) and a `BREAKING CHANGE:` footer.
- Example: `feat(cli): add --file option for the backlog path`.

# Repository instructions

## Environment

- Use the fish shell.
- Never use `npm` or `npx` in this repository.
- Use `nub` for package management and scripts, and `nubx` to run package binaries.
- Use `nub.lock` as the lockfile. Never create `package-lock.json`.
- Use `task check` before publishing changes and `task deploy` for deployment.

## Git

- Ignore unrelated worktree changes from concurrent work. Never undo them.
- Keep credentials out of Git. `.cloudflare-api-token` must remain gitignored.
- This repository is public. Keep account IDs, resource IDs, private keys,
  and local paths in ignored configuration or Actions secrets. The public
  MCP URL belongs in README.md.

## Approvals

- When multiple commands need the same new approval prefix, request and finish
  the first approval before launching the remaining commands. Never parallelize
  approval-gated commands until the reusable prefix rule is stored.

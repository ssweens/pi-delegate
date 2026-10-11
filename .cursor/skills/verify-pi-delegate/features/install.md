# Install the extension

Packing pi-delegate and installing it into a clean Pi proves the shipped artifact registers its
tools, roles, and runtime with no help from the checkout.

## Sub-features

- `install-pack` packs only the files users need (no tests, scripts, or vendored sources).
- `install-tools` registers `delegate`, `delegate_ctl`, `todo`, and `mom` exactly once each.
- `install-roles` loads the `reviewer`, `scout`, and `worker` roles.
- `install-acp` answers an ACP `initialize` from both bundled adapters with `protocolVersion 1`
  resolving every dependency inside the installed package.

## How to get to it (user POV)

- Install the packed tarball into Pi (`pi install <source>`) in a fresh project.
- Open Pi and confirm the delegate tools and Mom respond.

## Driving it with tmux

Preconditions:

- `npm run build` passes so `dist/` is fresh (the pack asserts the runtime files exist).
- No Pi instance in the run points at the real home.

This recipe needs no TUI. Run it headless from the repo root:

```sh
npm run check:install
```

- **Pack.** The dry run asserts every required file is packed (extension sources, Mom runtime,
  roles, delegation skill, docs, ACP binaries, runtime module) and no test, script,
  `node_modules`, or stray vendor source ships.
- **Tools.** After `pi install <tarball>` into the isolated home, the loader reports no
  extension errors and each of `delegate`, `delegate_ctl`, `todo`, and `mom` appears exactly
  once. The `delegation` skill resolves with `Model per role` content.
- **Roles.** `loadRoles` from the installed copy returns exactly `reviewer`, `scout`,
  `worker`.
- **ACP.** Both `dist/pi-acp.js` and `dist/amp-acp.js`, started from the installed copy and fed
  an `initialize` frame on stdin, exit `0` and reply with the same `id` and
  `protocolVersion 1`. Every dependency resolves under the installed root, never the checkout.
- **Proof.** The `PASS <n> packaged files, Pi <v> in <range>, isolated pi install ...` line is
  the artifact. It names the installed root, which must not sit inside the repo checkout.

## Gotchas

- The package is private and local-only. Any `publish` path invalidates this recipe; re-check
  `private: true` first.
- Without an explicit source argument the recipe installs the just-packed artifact, not a
  possibly stale published release. That is deliberate.
- The temp root is removed on exit, success or failure. A failed run's evidence is the
  assertion text itself, so keep the full command output.

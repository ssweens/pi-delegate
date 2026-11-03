# Child instruction context

Operator-directed behavior: ordinary fresh Pi children receive startup instruction files by default, separately from the role system prompt. `omitAgentsMd` on a launch overrides role frontmatter, including explicit false. Scout opts out; worker and other ordinary roles include instructions.

- Fresh is the default when neither the launch nor the role selects a context. Explicit forks retain the parent's conversation, appended prompt and previously loaded instruction context. Fresh children inherit none of those.
- Startup includes Pi's applicable context-file hierarchy/fallbacks, unconditional `.agents/rules` and preferred global `~/.agents/AGENTS.md` (highest priority when included).
- Omission skips startup instructions only. Successful reads still discover nested files and matching path-scoped rules; skipped global/root files must not reappear through a read of a global skill. Failed reads add nothing.
- Save file snapshots and omission on the run; reopen uses the saved state. Deduplicate model-visible instruction blocks against inherited context. Keep instruction messages distinct from the role's system prompt.
- Do not modify installed packages, live homes, existing execution ownership, trust or permission rules.
- ACP and process reject this Pi-only option. Oven and native hosted TUIs own a separate instruction-loading path; reject an explicit omission setting (including false), or an omitting role, before starting those unsupported launches rather than claim the in-process semantics apply there. Their current default loading is unchanged.

Implementation seams: `roles.ts` (role value); `backend.ts` (launch validation); `index.ts` (`resolvePi`, `childLoader`, inline child hooks); `pi-backend.ts` (saved run fields and startup materialization). Verify with the real Pi session and localhost provider fixture: default, omission, scout false, read discovery, global-skill omission, fresh isolation, fork inheritance/override, resume and duplicate suppression. Use focused tests and typecheck; no live model calls.

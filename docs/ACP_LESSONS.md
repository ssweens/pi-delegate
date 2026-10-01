# ACP backend lessons

Lessons learned while building the ACP backend, first as the pi-strings package. They still apply to `src/acp/` and to `delegate backend:"acp"`. The original file is `pi-strings/tasks/lessons.md` at `0238492^`.

- **Reload Pi before validating through live tools.** After changing extension code, reload Pi before you check behavior through the extension's tools. A fresh-process integration test does not prove that the loaded tool instance has the fix.
- **Keep presets separate from model choice.** A role or profile preset is not the model control. Expose ACPX model discovery and per-run model choice instead.
- **Don't require a preset to start an ACP agent.** `delegate backend:"acp"` takes `agent` directly. Presets are optional policy bundles, not constructors.
- **Read-only means reads allowed, mutations denied.** Check ACPX's native `approve-reads` behavior before adding policy code.
- **Keep the proxy thin.** The ACP backend passes ACPX's native controls through. Don't add provider-specific permission callbacks or emulate a downstream agent's policy.
- **Read the real permissions docs first.** Before changing ACPX permission behavior, read the authoritative `openclaw/acpx` permissions documentation: modes, JSON policy precedence, matching syntax, escalation and non-interactive behavior. Don't infer the contract from type declarations or CLI help.

---
name: delegate-model-setup
description: Review or change Pi delegate models per role. Use when asked to set up model defaults, check for drift or newer versions, compare model deals, change a delegate's model, or recover from MODEL_REVIEW_REQUIRED. Ordinary launches check defaults without this skill.
---

# Delegate model setup and review

1. Run `delegate_ctl action=models`. Read the affected role's approved offering, blockers, upgrade option, and notices. One new usable same-tier candidate, five new usable model IDs, or a material price increase blocks automatic launch. For catalog growth, inspect the added models for role fit before recommending anything. The tool result's `details.defaults.newModelIds[role]` holds the complete list; use `message=<substring>` to look up exact offerings, including unrated ones. If none fits, recommend keeping the current model and say why.
2. Make one proposal per affected role. Name the exact `provider/id[:thinking]`, input/output price, serving tradeoff (subscription, metered, free, local, or timed), and quality evidence. Say when quality is unverified. A higher version is a candidate, not proof that it is better at the role.
3. Offer **keep current**, **try once**, or **make default**. If the current offering is unavailable, omit **keep current**. If its price rose, show the new rates before asking. Approval age and missing live data do not block.
4. Wait for the user's answer. **Try once:** call `delegate` with explicit `model:` and `reason:`; the role's review stays pending. **Make default** or **keep current after review:** root parent calls `delegate_ctl action=approve role=<role> model=<chosen or current exact spec> message=<reason>`, then launches without `model:`. Approval acknowledges the reviewed catalog for that role only. To switch an existing run, use `delegate_ctl steer` with `model:` only after the user agrees. A nested delegate reports proposals to its parent; it does not approve defaults.

Approval is per role. Never switch or approve automatically, and never retry `MODEL_REVIEW_REQUIRED` with an explicit override without the user's approval. `models` and the automatic launch check use the same blocking rules. Neither this skill nor a separate `models` call is required for an ordinary launch.

## Comparing offerings

- Compare exact provider routes, not just weights. Zero listed price does not mean unlimited usage. Check context, tool support, pricing tiers, rate limits, and serving quality against the task. Don't propose an unconfigured, expired, or batch-only route for a live child.
- `models` shows Artificial Analysis (AA) data for the exact OpenRouter IDs when available. Don't transfer that score to another provider as a verified fact. Use `delegate_ctl action=rate` to record separately sourced or measured quality for the exact offering; ratings older than 14 days are stale.
- For promotions and off-peak rates, use `delegate_ctl action=deals` or `/deals [substring]`. A listed endpoint promotion may need provider pinning; the reported offer is not necessarily the price the child will pay. Check the current window and exact usable route in `models` before proposing it.
- This workflow is for Pi roles. For ACP, read the external agent's own catalog with `delegate_ctl models runId=<id>` when a run exists; an existing native session keeps its own choice. A process run has no model.

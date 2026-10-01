# Third-party notices

The ACP runtime under `src/acp/`, `vendor/`, and `dist/` moved here from pi-strings (todo 041). Its attributions are unchanged.

`vendor/pi-acp/src` is derived from [`svkozak/pi-acp`](https://github.com/svkozak/pi-acp) at commit `d1cffc047ab37a096ee70ca39cfc1de463db8d12` (version 0.0.33), Copyright © 2025 Sergii Kozak, under the MIT License in `vendor/pi-acp/LICENSE`.

The vendored adapter is intentionally maintained here because Pi worker launch policy, RPC deadlines, process ownership, state durability, and error semantics are part of the ACP backend's safety boundary.

`vendor/acpx` is a source snapshot of [`openclaw/acpx`](https://github.com/openclaw/acpx) at commit `e91cc50439e7ed58845fca82e23c72dcaaf7fd8a` (based on version 0.13.0), Copyright © 2025 OpenClaw Team, under the MIT License in `vendor/acpx/LICENSE`. `npm run build:acpx` compiles its public runtime entry into `dist/acpx-runtime`, which is wrapped by an internal port so it can be replaced without changing the Pi tool contract.

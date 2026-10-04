# Codx Remote 0.9.0

The public Render site and account dashboard share the new silver branding, responsive layouts, keyboard focus states, hover transitions, scroll reveals and reduced-motion support. Installation keeps the existing PowerShell command and visible/background menu unchanged.

The dashboard provides Devices, Usage, Plan & billing, and Settings. It uses account-scoped device data, monthly counters and client metadata. Claude is marked as under maintenance. Paid billing is explicitly unavailable; the interface does not simulate a checkout or third-party subscription status.

Additive database tables record MCP client connections, opaque MCP sessions, account preferences, and 30-day operation metadata. Operation contents, arguments and paths are excluded from usage history. Existing accounts, device credentials, OAuth tokens and counters are preserved. The client name is self-reported MCP metadata, not a chat title or proof of a third-party subscription.

`show_activity` is a separate read-only render tool with an inline MCP Apps resource. The animated brand reacts to actual queued/running device commands. Native ChatGPT search indicators cannot be replaced. Clients without MCP Apps retain useful text results. The private plugin includes the new PNG identity and a remote-work skill that opens the activity view at the start of computer tasks.

Validation: 12 integration tests cover authentication, isolation, key rotation, OAuth compatibility and revocation, persistent settings, escaped profile rendering, private usage export, MCP activity resources, and completed device operations. Desktop and 390px mobile layouts were inspected in the browser with local-only fixtures. Actual rendering of the inline card in the authenticated ChatGPT host requires a post-release connection test.

Hosting remains the existing Render static site and web service. Only `codx-remote/` is changed.

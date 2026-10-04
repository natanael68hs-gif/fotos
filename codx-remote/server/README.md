# Codx Remote Backend 0.5

Persistent backend for Codx Remote.

## Architecture

Render Static Site hosts the public website.
Render runs the persistent Node.js API/MCP backend.
Render Postgres stores accounts, devices, sessions, commands, usage and OAuth state.

Public website:
https://codx-remote.onrender.com

## Connect without repeated OAuth login

Sign in to the backend dashboard once at
https://codx-remote-api-zrider.onrender.com/dashboard and choose
**Baixar configuração do Codex**. Add that TOML snippet to your personal
`~/.codex/config.toml` and restart Codex. Disable the plugin's previous OAuth
MCP connection to avoid duplicate tools. Other MCP clients can download the
JSON configuration using **Baixar configuração MCP** instead.

The configuration sends the account's permanent MCP key as an Authorization
Bearer header. It does not expire and works until the key is rotated. No key
is embedded in the shared plugin or committed to the repository. Treat the
download as a credential and keep it in your personal configuration only.
The dashboard's **Trocar chave** button invalidates earlier configurations;
download and install the new configuration after rotating.

OAuth connections and existing query-key clients remain supported. Anonymous
requests remain rejected, and each key can only access its account's devices.
The JSON download is a legacy HTTP-client configuration; portable plugin
`mcp.json` continues to use the standard `streamable-http` transport.

Production requires `DATABASE_URL` so accounts and keys persist across deploys.
The in-memory database is only suitable for local tests.

Run authentication integration tests with `npm test` in this directory.

## Windows installer for ChatGPT

Run `irm https://codx-remote.onrender.com/install.ps1 | iex` in PowerShell.
The installer uses `%USERPROFILE%\.codx-server-remote` (for example,
`C:\Users\Usuario\.codx-server-remote`), protects its credentials with a
user-specific ACL, and preserves the old `%LOCALAPPDATA%\CodxRemote` directory.
It downloads the agent, writes start/stop scripts and logs, and adds a per-user
startup shortcut. The agent runs in the background; PowerShell can be closed.

After the account/device is authorized, the agent generates `mcp.json` and
opens the existing private ChatGPT plugin during installation. ChatGPT must
still install/connect that plugin and authorize the account through its own
interface. Creating a local directory cannot grant a normal ChatGPT chat MCP
tools. Startup does not reopen the plugin once the device is already authorized.

The backend and static site serve the same installer file. Stop the agent with
the generated `stop.ps1`; remove the `Codx Remote.lnk` startup shortcut to
disable automatic startup. Rerunning the installer updates the managed agent.

## Render Blueprint

The repository root contains `render.yaml`.

It creates:

- Web service: `codx-remote-api-zrider`
- Postgres: `codx-remote-db-zrider`

The web service expects `DATABASE_URL` from Render Postgres and exposes:

- `GET /health`
- `POST /api/register`
- `POST /api/device?action=...`
- `GET|POST /api/auth?action=...`
- `POST /api/dashboard-action`
- `GET|POST /api/mcp`
- OAuth discovery and OAuth 2.1/PKCE endpoints.

The public static site links directly to the Render backend for the dashboard and OAuth.

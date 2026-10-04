# Codx Remote Backend 0.5

Persistent backend for Codx Remote.

## Architecture

Vercel hosts the public website.
Render runs the persistent Node.js API/MCP backend.
Render Postgres stores accounts, devices, sessions, commands, usage and OAuth state.

Public website:
https://codx-remote-zrider.vercel.app

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

After the Render URL is known, Vercel should proxy the API/OAuth paths to the Render service.

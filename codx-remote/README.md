# Codx Remote

Codx Remote is a Windows-first setup layer for using a local MCP server from supported OpenAI products through OpenAI Secure MCP Tunnel.

## One-command start

```powershell
irm https://codx-remote-zrider.vercel.app/install.ps1 | iex
```

On first run the installer:

1. Checks for Node.js / npx and installs Node.js LTS with winget when needed.
2. Downloads the latest official OpenAI `tunnel-client` Windows release.
3. Verifies the downloaded tunnel-client against the release SHA256 manifest when available.
4. Prompts for an OpenAI Tunnel ID and Runtime API key.
5. Stores the runtime key locally using Windows DPAPI.
6. Creates a `codx-remote` tunnel-client profile that launches the open-source Desktop Commander MCP server.
7. Runs `doctor --explain`.
8. Starts the tunnel in the foreground with the local manager UI at:
   `http://127.0.0.1:8080/ui`

Closing the terminal or pressing Ctrl+C disconnects the device.

## Architecture

ChatGPT / supported OpenAI client
-> OpenAI Secure MCP Tunnel
-> tunnel-client on the Windows PC
-> Desktop Commander local MCP server
-> local files / terminal / processes

No inbound router port is required for Secure MCP Tunnel.

## ChatGPT connection

In ChatGPT Plugins, create/add an MCP app and choose **Tunnel** as the connection type, then select the same Tunnel ID used by the installer.

Availability of custom MCP tools and write actions depends on the ChatGPT account/workspace permissions.

## Security notes

- The tunnel client runs only while the terminal is open.
- The local admin UI binds to loopback by default.
- The Runtime API key is protected with Windows DPAPI for the current Windows user.
- Treat access to the connected ChatGPT/OpenAI account as equivalent to remote access to the tools exposed by the MCP server.
- Prefer project-specific directory restrictions and review terminal commands before execution when working with untrusted content.

## Components

- OpenAI tunnel-client: https://github.com/openai/tunnel-client
- Desktop Commander local MCP server: https://github.com/wonderwhy-er/DesktopCommanderMCP
- Website: https://codx-remote-zrider.vercel.app

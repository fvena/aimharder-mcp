# Remote use from Claude and ChatGPT

Claude and ChatGPT on the web, desktop and mobile can't start a local process. They connect from their own cloud to a **remote MCP server**: a public HTTPS URL. In HTTP mode this server provides one for your account.

For a beginner-friendly walkthrough, see the [step-by-step setup guide](setup-guide.md). This page is the technical reference.

Each person runs their **own instance** for their own account. The instance keeps your AimHarder credentials in your hosting platform's secrets. Nobody else, including the project's authors, sees or stores them.

## How it works

- `MCP_TRANSPORT=http` serves MCP (Streamable HTTP) at `<MCP_PUBLIC_URL>/mcp`.
- The endpoint is protected by OAuth 2.1, which Claude and ChatGPT support. The server is its own authorization server, with dynamic client registration and PKCE.
- When you connect a client, it opens an approval page on your server. You type `MCP_OWNER_SECRET` there, and the client then gets its own tokens. Access tokens last one hour and refresh tokens 30 days, renewed automatically.
- Nothing is stored on disk. Client registrations and tokens are signed with a key derived from `MCP_OWNER_SECRET`, so they survive restarts. **Changing the secret disconnects every client.**
- Redirects are allowed only to Claude's and ChatGPT's callback URLs, loopback URLs (local clients such as Claude Code) and any URLs you add in `MCP_OAUTH_REDIRECT_URIS`.
- Failed secret attempts are limited to 10 every 15 minutes.
- Requests whose `Host` is not the host of `MCP_PUBLIC_URL` are rejected. `GET /healthz` answers `{"status":"ok"}` for health checks.
- Run **one instance**. AimHarder sessions and the two-minute preview references live in memory, so a confirmation must reach the instance that prepared it.

The write rules are the same as over stdio: every booking, cancellation or result needs a preview and an explicit confirmation in the chat.

## 1. Choose a secret

Generate a long random value for `MCP_OWNER_SECRET` (at least 16 characters; more is better) and keep it in your password manager:

```sh
openssl rand -base64 32
```

## 2. Deploy

Any platform that runs a container behind HTTPS works. The [Dockerfile](../Dockerfile) builds the image and listens on `0.0.0.0:8080`. Set these secrets on the platform:

| Secret | Value |
| --- | --- |
| `AIMHARDER_USERNAME`, `AIMHARDER_PASSWORD` | Your AimHarder login |
| `MCP_PUBLIC_URL` | The HTTPS origin the platform gives you, without a path, for example `https://my-aimharder.fly.dev` |
| `MCP_OWNER_SECRET` | The secret from step 1 |
| Optional `AIMHARDER_*` settings | Gym, time zones, windows, workout class and booking plan, as in [configuration](configuration.md) |

The platform's own subdomain is enough; you don't need a domain of your own. Keep the instance count at one, and use a region close to you.

### Fly.io example

```sh
fly launch --no-deploy
fly secrets set AIMHARDER_USERNAME=you@example.com AIMHARDER_PASSWORD='…' MCP_OWNER_SECRET='…' MCP_PUBLIC_URL=https://<app>.fly.dev
fly deploy
fly scale count 1
```

If Fly's remote builder fails, build with your local Docker: `fly deploy --local-only`. With Docker Desktop, point flyctl at its socket: `DOCKER_HOST=unix://$HOME/.docker/run/docker.sock`.

#### Deploy automatically from GitHub

The [Deploy workflow](../.github/workflows/deploy.yml) redeploys your Fly app after CI passes on a push to `main`. It is opt-in, and repositories without the variable skip it. In your repository (or fork):

```sh
gh variable set FLY_APP --body <app>
gh api --method PUT repos/<owner>/<repo>/environments/production
fly tokens create deploy -a <app> | gh secret set FLY_API_TOKEN --env production
```

The deploy token is limited to that one app. Secrets stay in Fly; the workflow only builds and rolls out the image.

### From your own computer

You can also run the server at home and publish it with a tunnel that gives a stable HTTPS URL, such as Tailscale Funnel or a named Cloudflare Tunnel. It is then only reachable while your computer is on.

```sh
MCP_TRANSPORT=http MCP_PUBLIC_URL=https://<machine>.<tailnet>.ts.net PORT=3000 \
  node --env-file=/absolute/path/to/aimharder.env dist/index.js
tailscale funnel 3000
```

Check the deployment: `https://<your-host>/healthz` should answer `{"status":"ok"}`.

## 3. Connect a client

The server URL is always `<MCP_PUBLIC_URL>/mcp`.

**Claude** (claude.ai, desktop and mobile apps): open **Customize → Connectors → Add custom connector** and enter the URL. If Claude asks how to identify itself, choose **Register automatically**. Claude opens the approval page; type your owner secret. The connector then appears in the mobile app too.

**ChatGPT** (web): open **Settings → Apps → Advanced settings**, turn on **Developer mode**, then **Create app** with the URL and OAuth authentication. Approve with your owner secret. In a chat, choose Developer mode from the **+** menu and select the app.

**Claude Code**:

```sh
claude mcp add --transport http aimharder https://<your-host>/mcp
```

Then authenticate from `/mcp`.

## Security notes

- Anyone who knows the owner secret can connect a client that acts on your AimHarder account. Use a long random value and change it if it leaks; changing it disconnects every client.
- Your AimHarder credentials live only in your platform's secrets and in the process memory, never in tool results, errors or logs.
- The server signs in to AimHarder from the platform's IP address. AimHarder's API is undocumented, and AimHarder may limit or block access.

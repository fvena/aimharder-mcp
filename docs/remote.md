# Remote use from Claude and ChatGPT

Claude and ChatGPT on the web, desktop and mobile can't start a local process. They connect from their own cloud to a **remote MCP server**: a public HTTPS URL. In HTTP mode this server provides one for your account, the *owner*, and for the friends you invite, each with their own AimHarder account.

You run your **own instance**. It keeps your AimHarder credentials in your hosting platform's secrets, and your members' credentials encrypted on its own disk. Nobody else, including the project's authors, sees or stores them.

## How it works

- `MCP_TRANSPORT=http` serves MCP (Streamable HTTP) at `<MCP_PUBLIC_URL>/mcp`.
- The endpoint is protected by OAuth 2.1, which Claude and ChatGPT support. The server is its own authorization server, with dynamic client registration and PKCE.
- When a person connects a client, it opens an approval page on your server. They sign in there with their AimHarder email and password: the owner's are checked against `AIMHARDER_USERNAME`/`AIMHARDER_PASSWORD`, a member's with AimHarder itself, and only accounts the owner invited are accepted. The client then gets tokens for that account. Access tokens last one hour and refresh tokens 30 days, renewed automatically.
- Each account has its own AimHarder sessions, single-use previews and settings. A member only ever reaches their own AimHarder account.
- Client registrations, tokens and web sessions are signed with a key derived from `MCP_OWNER_SECRET`, so they survive restarts. **Changing the secret disconnects every client.** Removing a member, or inviting them again, invalidates their tokens.
- Members, pending invitations and settings live in one SQLite file in `MCP_DATA_DIR`, which must be persistent storage (a volume). Members' AimHarder credentials are encrypted there with AES-256-GCM under a second key derived from `MCP_OWNER_SECRET`; invitation links and calendar links are stored only as digests.
- Redirects are allowed only to Claude's and ChatGPT's callback URLs, loopback URLs (local clients such as Claude Code) and any URLs you add in `MCP_OAUTH_REDIRECT_URIS`.
- Failed sign-ins (approval page, settings and invitations) are limited to 10 every 15 minutes per client address.
- Web pages use a signed, HttpOnly session cookie and accept form posts only from the server's own origin.
- Calendar links (`GET /calendar/<token>.ics`) are limited to 60 requests every 15 minutes per client address. The token is never logged.
- Requests whose `Host` is not the host of `MCP_PUBLIC_URL` are rejected. `GET /healthz` answers `{"status":"ok"}` for health checks.
- Run **one instance**. AimHarder sessions and the two-minute preview references live in memory, so a confirmation must reach the instance that prepared it.

The write rules are the same as over stdio: every booking, cancellation or result needs a preview and an explicit confirmation in the chat.

## 1. Choose a secret

Generate a long random value for `MCP_OWNER_SECRET` (at least 16 characters; more is better) and keep it in your password manager. Nobody types it; it protects tokens and stored passwords:

```sh
openssl rand -base64 32
```

## 2. Deploy

Any platform that runs a container behind HTTPS and offers a persistent volume works. The [Dockerfile](../Dockerfile) builds the image, listens on `0.0.0.0:8080` and keeps its data in `/data`; mount a volume there. Set these secrets on the platform:

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
fly volumes create aimharder_data --region ams --size 1
fly secrets set AIMHARDER_USERNAME=you@example.com AIMHARDER_PASSWORD='…' MCP_OWNER_SECRET='…' MCP_PUBLIC_URL=https://<app>.fly.dev
fly deploy
fly scale count 1
```

[fly.toml](../fly.toml) mounts the `aimharder_data` volume at `/data`. Create it in the app's region before the first deploy; Fly does not create it for you.

#### Upgrading a deployment from before accounts

Earlier versions stored nothing and approved connections with the owner secret. (Data files of earlier multi-account versions are upgraded on start. Members and invitations stay. Each account keeps what applied at its gym: its default gym, else the only gym its settings name, with that gym's rules from `/admin` (time zone, windows), workout class and plan. The shared gym rules and active gyms are dropped, and members no longer inherit the environment's workout class: they set their own. Personal settings in the formats of the first multi-account version are cleared, to be entered again on the settings page.) To upgrade, create the volume once, then deploy:

```sh
fly volumes create aimharder_data --region ams --size 1 -a <app>
fly deploy -a <app>
```

If the deploy says the machine has no volume, run `fly scale count 0 -a <app>` and deploy again; the new machine attaches the volume. Existing connections keep working, as the owner's. New connections sign in with the owner's AimHarder account instead of the owner secret.

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

**Claude** (claude.ai, desktop and mobile apps): open **Customize → Connectors → Add custom connector** and enter the URL. If Claude asks how to identify itself, choose **Register automatically**. Claude opens the approval page; sign in with your AimHarder account. The connector then appears in the mobile app too.

**ChatGPT** (web): open [Plugins](https://chatgpt.com/plugins), select **+ → Add custom MCP server**, enter the server URL and choose OAuth with dynamic client registration. Create and install the plugin, then select it with `@` in a chat. Sign in with your AimHarder account on your server's approval page when prompted. The server accepts ChatGPT's per-connection callback at `https://chatgpt.com/connector/oauth/{callback_id}` and its older fixed callback.

**Claude Code**:

```sh
claude mcp add --transport http aimharder https://<your-host>/mcp
```

Then authenticate from `/mcp`.

## 4. Invite friends and change settings

Every account has a settings page at `<MCP_PUBLIC_URL>/settings` (sign in with AimHarder): its gym (chosen among the account's gyms when it has several; changing it clears the other settings) and that gym's time zone, booking window and cancellation window, workout class and weekly booking plan chosen from the gym's timetable (several classes per day allowed), participant filter, and friends. Friends are added by ticking them among a class's participants; their name can be changed to the one you know them by, and their AimHarder picture is shown and refreshed when they appear again. One small script from the server (`/assets/app.js`) shows only the chosen weekday's classes in the plan form, adds copy buttons for the connector address and invitation links, and moves focus to the outcome of the last change; every page works without it. `get_account_context` reports this URL as `settingsUrl`. See [configuration](configuration.md#settings-page-http-only) for how these settings combine with the environment.

### Calendar feed

Under **Calendario** on the settings page, each account creates a private link to an iCalendar feed of its upcoming bookings, `<MCP_PUBLIC_URL>/calendar/<token>.ics`, to subscribe to from Apple Calendar, Google Calendar, Outlook or any app that accepts calendar URLs. Calendar apps cannot sign in with OAuth, so the link itself is the credential: a random 256-bit token, shown once and stored only as a SHA-256 digest. Creating a new link replaces the old one, which stops working (the page says so under the new link, which also happens when the form is sent again by reloading); **Desactivar el enlace** removes it, and removing a member removes theirs. Unknown, replaced and removed links answer 404. The section appears once the account has a gym; changing gyms keeps the link, which then lists the new gym's bookings.

- The feed lists what `get_upcoming_bookings` reads at the account's gym: one event per booking, with the class as title, the gym as location and its start and end times as UTC instants, converted from the gym-local times with the gym's time zone (`Europe/Madrid` when none is confirmed). Calendar apps show them in the device's zone.
- `STATUS` follows what AimHarder says: `CONFIRMED` for a booking, `TENTATIVE` and "(lista de espera)" in the title for the waitlist, and no `STATUS` when AimHarder reports another state. Cancelled and past bookings are not in AimHarder's upcoming view, so they disappear; keep history in the calendar app if you want it.
- Each booking keeps the same `UID` on every read (`<gym>-<booking ID>@aimharder-mcp`), independent of the server's address, so subscribers update events in place. A booking taken from the waitlist is a new booking with a new ID (AimHarder does not move the waitlist up by itself), so it replaces the waitlisted event.
- AimHarder is read at most every five minutes per account (`Cache-Control: private, max-age=300`, with an `ETag` for `If-None-Match`). If AimHarder cannot be read, or the account's gym is no longer its own, the feed answers 503 with `Retry-After` instead of an empty calendar, so subscribers keep what they had.

The owner also has `/admin`, for people only (each account configures its own gym):

- **Personas con acceso**: lists members and pending invitations, and creates invitations. Removing a member asks for confirmation first, then deletes their stored credentials and settings and invalidates their tokens and sessions.
- **Invitar a alguien** (in the same section): creates a single-use link, valid for seven days, for a named person. The link is shown once. The person opens it, signs in with their AimHarder account, and gets a page with the connector address and the steps for Claude and ChatGPT.

The pages are in Spanish, for the gym's members.

## Security notes

- The owner secret protects every token and the stored passwords. Use a long random value and change it if it leaks; changing it disconnects every client and signs everyone out.
- Anyone with an invited account's AimHarder password can connect a client for that account, as they could use the AimHarder app.
- Your AimHarder credentials live only in your platform's secrets and in the process memory. Members' credentials are also encrypted on the volume, readable only with the owner secret. None of them appear in tool results, errors, logs or pages.
- As the owner, you hold your members' AimHarder passwords. Invite only people who trust you, and remove them when they ask.
- The server signs in to AimHarder from the platform's IP address. AimHarder's API is undocumented, and AimHarder may limit or block access.

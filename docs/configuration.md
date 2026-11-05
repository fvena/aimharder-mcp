# Configuration

Locally over stdio (default), the server serves one AimHarder account. Remotely over HTTP with OAuth ([remote use](remote.md)), it serves that account, its *owner*, plus the people the owner invites, each with their own AimHarder account. It reads its settings from the process environment; it does not load files by itself. Keep credentials in a private file (`chmod 600`) outside the repository and pass it with `node --env-file=…`, or let your MCP client inject the variables.

## Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `AIMHARDER_USERNAME` | yes | Account login (email). |
| `AIMHARDER_PASSWORD` | yes | Account password. Whitespace is preserved. |
| `AIMHARDER_DEFAULT_GYM` | with several gyms | Gym ID used when a tool call does not name one. Must be one of the IDs `get_account_context` returns. |
| `AIMHARDER_GYM_TIME_ZONES` | for writes | JSON object from gym ID to IANA zone, for example `{"undergroundrv":"Europe/Madrid"}`. Unmapped gyms use an explicitly *assumed* `Europe/Madrid`. Bookings, cancellations and saved results require a confirmed zone. |
| `AIMHARDER_BOOKING_WINDOW_DAYS` | no | JSON object from gym ID to days (1–60). Booking opens that many days before the class, at the same gym-local time. Sessions then report `bookingOpensAt`/`bookingOpen`, and booking previews return `not-yet-open` before that time. |
| `AIMHARDER_CANCELLATION_WINDOW_MINUTES` | no | JSON object from gym ID to minutes (1–10080). Cancelling within that many minutes of the class may lose a credit. Cancellation previews warn inside the window, and a preview prepared before the window opened becomes `stale`. |
| `AIMHARDER_REQUIRE_BOOKING_CONFIRMATION` | no | `true` (default) or `false`. With `false`, an explicit request to book an exact class is enough to execute its preview. Cancellations and saving or deleting results always require confirmation. |
| `AIMHARDER_PARTICIPANTS_FILTER` | no | `all` (default) or `friends`. Default for `get_class_participants`: everyone in the class, or only your `AIMHARDER_FRIENDS`. Each call can still choose with `filter`. |
| `AIMHARDER_FRIENDS` | no | JSON object from AimHarder user ID to a friend: the `name` you know them by and an optional HTTPS `photoUrl`, for example `{"123456":{"name":"Laura"}}` (at most 200). The `friends` filter shows only them, and participant lists add their `friendName`. `get_class_participants` with `filter: all` shows each participant's `userId` and `photoUrl`. |
| `AIMHARDER_WORKOUT_CLASS` | no | JSON object from gym ID to the exact workout class name in the gym feed, for example `{"undergroundrv":"CROSS"}`. The workout tools use it when a call has no `className`, so "what is today's workout?" needs no class. Naming another class (for example HYROX) still works. Without it, those calls return `class-required` with the published class names. |
| `AIMHARDER_BOOKING_PLAN` | no | JSON object from gym ID to a weekly plan: a list of entries, each with a weekday `day` (`mon`–`sun`), an exact `className` and a `startTime` (`HH:mm`), for example `{"undergroundrv":[{"day":"mon","className":"CROSS","startTime":"07:00"},{"day":"mon","className":"HYROX","startTime":"19:00"}]}`. A weekday may have several classes; the plan is kept in weekday and time order, without duplicates (at most 50 entries). `prepare_planned_bookings` previews these classes for a date range, so "book next week" needs no class list. Each booking is still previewed and executed separately. |

### Remote (HTTP) transport

| Variable | Required | Description |
| --- | --- | --- |
| `MCP_TRANSPORT` | no | `stdio` (default) or `http`. |
| `MCP_PUBLIC_URL` | with `http` | Public origin, without a path, for example `https://my-aimharder.fly.dev`. HTTPS is required except for `localhost`. The MCP endpoint is `<origin>/mcp`, and requests for other host names are rejected. |
| `MCP_OWNER_SECRET` | with `http` | Secret, at least 16 characters, that nobody types: it derives the key that signs tokens and sessions and the key that encrypts members' stored passwords. Changing it disconnects every client and signs everyone out; members sign in again with their AimHarder account. |
| `MCP_DATA_DIR` | no | Directory for the SQLite file with members, invitations and settings. Default `data` (relative to the working directory); the Docker image uses `/data`, which must be a persistent volume. |
| `MCP_HTTP_HOST` | no | Listening address. Default `127.0.0.1`; the Docker image uses `0.0.0.0`. |
| `PORT` | no | Listening port, 1–65535. Default `3000`; the Docker image uses `8080`. |
| `MCP_OAUTH_REDIRECT_URIS` | no | Extra OAuth redirect URIs, comma-separated (HTTPS, or HTTP on loopback). Claude's and ChatGPT's callbacks and loopback URIs are always accepted. |

Invalid values stop the server at startup with a specific error code (for example `INVALID_TIME_ZONE_CONFIGURATION` or `INVALID_HTTP_CONFIGURATION`), before any request is sent.

### Settings page (HTTP only)

On the remote server, each account edits its own preferences at `<MCP_PUBLIC_URL>/settings`, and the owner edits the gym rules at `/admin`. They are stored in `MCP_DATA_DIR` and override the environment:

| Layer | Who edits it | Settings |
| --- | --- | --- |
| Environment | owner, with platform secrets | everything above |
| Gym rules | owner, at `/admin` | the gyms the server uses (the others are hidden from every account and rejected by the tools), and per gym: time zone, booking window and cancellation window |
| Own preferences | each account, at `/settings` | default gym (with several active gyms), workout class, participant filter, weekly booking plan, friends with their names and pictures |

Per-gym values merge by gym ID, so an empty gym rule falls back to the environment. Choosing *Ninguna* as an account's workout class means none, even when the environment sets one; editing a gym's plan or the friends list keeps the entries that came from the environment. A default gym outside the active gyms is ignored, and an account none of whose gyms is active cannot join or sign in. Members inherit the environment's gym rules and workout class, but not the owner's default gym, booking plan, participant filter or friends, and always confirm bookings (`AIMHARDER_REQUIRE_BOOKING_CONFIRMATION` applies to the owner only). Credentials, secrets, URLs and the redirect allowlist stay environment-only.

The booking and cancellation windows are the rules your gym states. They prevent premature or unexpected requests, but AimHarder still decides whether a booking or cancellation is accepted.

## Gyms and time zones

Call `get_account_context` to list the accessible gyms, the selected one and each gym's `timeZoneStatus` (`assumed` or `user-confirmed`). With several gyms, set `AIMHARDER_DEFAULT_GYM`; any tool call can still select another accessible gym with `gymId`.

Dates in tool inputs and results are gym-local calendar dates (`YYYY-MM-DD`) and wall-clock times (`HH:mm`), without UTC offsets. With an assumed zone, words like "today" can resolve to the wrong date near midnight.

## Sessions

The server keeps two in-memory sessions for the same account and never writes them to disk:

- **Web session** (cookie): account and gym discovery, personal activity calendar.
- **App session** (token, valid about 90 days): everything else, the way the official mobile app works.

Every app request checks that the app account is the same as the web account. An expired session is renewed once for reads; writes are never resent after an expiry. See [aimharder-api.md](aimharder-api.md).

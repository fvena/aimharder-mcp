# Configuration

The server runs locally over stdio for one AimHarder account. It reads its settings from the process environment; it does not load files by itself. Keep credentials in a private file (`chmod 600`) outside the repository and pass it with `node --env-file=…`, or let your MCP client inject the variables.

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

Invalid values stop the server at startup with a specific error code (for example `INVALID_TIME_ZONE_CONFIGURATION`), before any request is sent.

The booking and cancellation windows are the rules your gym states. They prevent premature or unexpected requests, but AimHarder still decides whether a booking or cancellation is accepted.

## Gyms and time zones

Call `get_account_context` to list the accessible gyms, the selected one and each gym's `timeZoneStatus` (`assumed` or `user-confirmed`). With several gyms, set `AIMHARDER_DEFAULT_GYM`; any tool call can still select another accessible gym with `gymId`.

Dates in tool inputs and results are gym-local calendar dates (`YYYY-MM-DD`) and wall-clock times (`HH:mm`), without UTC offsets. With an assumed zone, words like "today" can resolve to the wrong date near midnight.

## Sessions

The server keeps two in-memory sessions for the same account and never writes them to disk:

- **Web session** (cookie): account and gym discovery, personal activity calendar.
- **App session** (token, valid about 90 days): everything else, the way the official mobile app works.

Every app request checks that the app account is the same as the web account. An expired session is renewed once for reads; writes are never resent after an expiry. See [aimharder-api.md](aimharder-api.md).

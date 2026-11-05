# aimharder-mcp

An [MCP server](https://modelcontextprotocol.io/) for one AimHarder account, run locally or deployed as your own remote connector for Claude and ChatGPT. Ask an AI client about classes and who is attending them, published workouts, bookings, personal activity and RMs. It can also make and cancel bookings, and save or delete strength results (PRs), always after your explicit confirmation.

It is an independent project, neither affiliated with nor endorsed by AimHarder. It talks to AimHarder's own web and mobile-app APIs, which are undocumented and can change without notice. See [docs/aimharder-api.md](docs/aimharder-api.md).

## Get started

1. Install Node.js **24 or newer**.
2. Build the server:

   ```sh
   npm ci --ignore-scripts
   npm run build
   ```

3. Put your settings in a private environment file outside the repository (`chmod 600`). [`.env.example`](.env.example) lists every option:

   ```dotenv
   AIMHARDER_USERNAME=you@example.com
   AIMHARDER_PASSWORD=your-password
   AIMHARDER_DEFAULT_GYM=your-gym-id
   AIMHARDER_GYM_TIME_ZONES={"your-gym-id":"Europe/Madrid"}
   AIMHARDER_BOOKING_WINDOW_DAYS={"your-gym-id":7}
   AIMHARDER_WORKOUT_CLASS={"your-gym-id":"CROSS"}
   ```

4. Add the server to your MCP client as a stdio command, for example in Claude Desktop:

   ```json
   {
     "mcpServers": {
       "aimharder": {
         "command": "node",
         "args": ["--env-file=/absolute/path/to/aimharder.env", "/absolute/path/to/aimharder-mcp/dist/index.js"]
       }
     }
   }
   ```

The first tool call signs in. Use `get_account_context` to see your gym IDs and time zones. See [configuration](docs/configuration.md) for details.

## Use it from Claude or ChatGPT on the web and mobile

Deploy your own instance (the [Dockerfile](Dockerfile) works on Fly.io, Render, Railway and similar platforms, or on your computer behind a tunnel) with `MCP_TRANSPORT=http`, `MCP_PUBLIC_URL` and an `MCP_OWNER_SECRET`. Then add `https://<your-host>/mcp` as a custom connector in Claude or as an app in ChatGPT developer mode, and approve it with your owner secret. Each person runs an instance for their own account; credentials stay in their own platform secrets. See [remote use](docs/remote.md).

## Tools

| Tool | Example question |
| --- | --- |
| `get_account_context` | Which gyms can I query? |
| `get_class_sessions` | Which CROSS classes are there this week, and when does booking open? |
| `get_class_participants` | Who is coming to today's 14:00 CROSS? Which of my friends? |
| `prepare_booking_creation` / `execute_booking_creation` | Book next Monday's 14:00 CROSS. |
| `prepare_planned_bookings` | Book my usual classes next week. |
| `prepare_booking_cancellation` / `execute_booking_cancellation` | Cancel Wednesday's class. |
| `execute_late_booking_cancellation` | Cancel inside the late window, accepting a possible credit loss. |
| `get_upcoming_bookings` / `get_booking_history` | When am I booked? Which classes did I attend? |
| `get_published_workouts` | What is today's WOD? And the HYROX one? |
| `get_published_workouts_range` | Summarize this week's CROSS workouts. |
| `get_personal_activity` | What did I record this month? |
| `get_exercise_1rm` / `find_exercise_1rm` / `get_exercise_rm_progression` | What is my Back Squat 1RM, and how has it progressed? |
| `prepare_exercise_result` / `execute_exercise_result` | Save 5 × 5 Back Squat at 90 kg today. |
| `prepare_exercise_result_deletion` / `execute_exercise_result_deletion` | Delete that result. |

Every write is a two-step flow: a read-only preview with a two-minute, single-use reference, then one confirmed request that is never retried automatically, followed by a fresh read to confirm the outcome. Details are in [tools](docs/tools.md).

## Development

```sh
npm run check   # typecheck, tests and build
```

Tests run against simulated AimHarder responses (msw), never the real service. Contributor notes are in [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE).

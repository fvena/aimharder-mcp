# Step-by-step setup guide

This guide takes you from nothing to asking Claude or ChatGPT about your AimHarder classes, on your computer and on your phone. You don't need to know how to program. Follow the steps in order and copy the commands exactly.

It takes about 30–45 minutes the first time.

## What you'll end up with

You'll have your own small server on the internet, at an address like `https://my-aimharder.fly.dev`. Only you can use it. Claude or ChatGPT connect to it and can then:

- tell you which classes there are and who is booked,
- show you the day's workout (WOD),
- book or cancel classes, and save your weights and records, **always asking you to confirm first**.

Your AimHarder password is stored only in your own server's settings. Nobody else receives it, including the authors of this project.

> This project is independent and unofficial. It is not made or endorsed by AimHarder, and it may stop working if AimHarder changes its system.

## What you need

| You need | Notes |
| --- | --- |
| Your AimHarder email and password | The ones you use in the AimHarder app. |
| A computer | macOS, Windows or Linux, only for the setup. Afterwards you use it from anywhere. |
| A [Fly.io](https://fly.io) account | Fly runs your server. It asks for a payment card. With the settings in this guide the cost is usually very low (the server sleeps when you're not using it), but check **Billing** in Fly's dashboard. |
| Claude or ChatGPT | **Claude**: any plan; the Free plan allows one custom connector. Works on the web, the desktop app and the mobile app. **ChatGPT**: a paid plan (Plus, Pro, Business…) with *Developer mode*. Works on the web; the mobile app may not show it. |
| A password manager (recommended) | To generate and keep the server's secret. |

## A few words you'll see

- **Terminal**: a window where you type commands. On macOS open the **Terminal** app; on Windows open **PowerShell** from the Start menu. Paste a command and press Enter.
- **Server**: the program that runs on Fly and talks to AimHarder for you.
- **Connector** (Claude) or **app** (ChatGPT): the link between the assistant and your server.
- **Owner secret**: a long password that only you know. You type it once when you connect Claude or ChatGPT, so nobody else can connect to your server.

---

## Step 1. Install the Fly tool

In the terminal:

**macOS or Linux**

```sh
curl -L https://fly.io/install.sh | sh
```

When it finishes, it prints a line to add Fly to your `PATH`. Copy and run it, or close the terminal and open a new one.

**Windows (PowerShell)**

```powershell
iwr https://fly.io/install.ps1 -useb | iex
```

Check that it works. It should print a version number:

```sh
fly version
```

## Step 2. Create your Fly account

```sh
fly auth signup
```

Your browser opens. Sign up with your email or GitHub, and add a payment card when Fly asks for one. If you already have an account, use `fly auth login` instead.

Check that you're signed in. It should print your email:

```sh
fly auth whoami
```

## Step 3. Download this project

1. Open the project page on GitHub.
2. Click the green **Code** button, then **Download ZIP**.
3. Unzip it in a folder you'll find again, for example `Documents/aimharder-mcp`.
4. In the terminal, go into that folder. Type `cd ` with a space, drag the folder onto the terminal window, and press Enter.

To check you're in the right place, list the files with `ls` (macOS/Linux) or `dir` (Windows). You should see `Dockerfile` and `fly.toml`.

## Step 4. Choose a name for your server

The name becomes your address: `https://<name>.fly.dev`. It must be unique across all of Fly. Use lowercase letters, numbers and dashes, for example `ana-aimharder`.

Create it, replacing `ana-aimharder` with your name, here and in every later step:

```sh
fly apps create ana-aimharder
```

If Fly says the name is taken, try another one.

## Step 5. Create your owner secret

Generate a long random password, at least 32 characters, with your password manager and save it there as "AimHarder MCP owner secret". If you don't have one, on macOS or Linux you can run:

```sh
openssl rand -base64 32
```

You'll need it in step 7 and whenever you connect Claude or ChatGPT.

## Step 6. Find your gym ID

Your gym ID is the first part of your gym's AimHarder web address. For example, if your gym's page is `https://undergroundrv.aimharder.es`, the ID is `undergroundrv`.

If you don't know it, you can ask Claude later: "What are my AimHarder gym IDs?" Leave the gym settings out for now and add them afterwards (see [Change a setting](#change-a-setting)).

## Step 7. Write your settings file

Create a plain-text file named `aimharder.env`, **outside** the project folder: for example in your home folder. Use TextEdit in plain-text mode (**Format → Make Plain Text**) on macOS, or Notepad on Windows.

Paste this and replace the values:

```dotenv
AIMHARDER_USERNAME=you@example.com
AIMHARDER_PASSWORD=your-aimharder-password
MCP_PUBLIC_URL=https://ana-aimharder.fly.dev
MCP_OWNER_SECRET=the-secret-from-step-5
AIMHARDER_GYM_TIME_ZONES={"undergroundrv":"Europe/Madrid"}
```

Rules that avoid most errors:

- **One setting per line.** Never split a value across several lines.
- **No quotes** around values, and no spaces around `=`.
- `MCP_PUBLIC_URL` is your address from step 4, starting with `https://`, **without** `/mcp` or a `/` at the end.
- In the lines with `{ }`, keep the double quotes `"` exactly as in the examples.

### Optional settings

Add any of these lines if you want them. Replace `undergroundrv` with your gym ID.

| Line to add | What it does |
| --- | --- |
| `AIMHARDER_DEFAULT_GYM=undergroundrv` | Needed only if your account belongs to several gyms. |
| `AIMHARDER_BOOKING_WINDOW_DAYS={"undergroundrv":7}` | Your gym opens bookings 7 days ahead. The assistant then won't try to book too early. |
| `AIMHARDER_CANCELLATION_WINDOW_MINUTES={"undergroundrv":90}` | Cancelling less than 90 minutes before a class may cost a credit. The assistant warns you. |
| `AIMHARDER_WORKOUT_CLASS={"undergroundrv":"CROSS"}` | The class whose workout you mean when you ask "what's today's workout?". Use the exact name shown in AimHarder. |
| `AIMHARDER_BOOKING_PLAN={"undergroundrv":{"mon":{"className":"CROSS","startTime":"14:00"},"sat":{"className":"CROSS","startTime":"09:30"}}}` | The class you usually book each weekday, so "book next week" just works. Days are `mon` `tue` `wed` `thu` `fri` `sat` `sun`. Times have two digits for the hour: `09:30`, not `9:30`. |
| `AIMHARDER_PARTICIPANTS_FILTER=following` | When you ask who's in a class, show only the athletes you follow in AimHarder. The default, `all`, shows everyone. |
| `AIMHARDER_REQUIRE_BOOKING_CONFIRMATION=false` | Book without a confirmation step when you name an exact class. Cancelling and saving results always ask. The default, `true`, always asks. |

[Configuration](configuration.md) explains every setting in detail.

## Step 8. Send your settings to Fly

In the terminal, inside the project folder. Replace the name and the path to your file.

**macOS or Linux**

```sh
fly secrets import -a ana-aimharder < ~/aimharder.env
```

**Windows (PowerShell)**

```powershell
Get-Content $HOME\aimharder.env | fly secrets import -a ana-aimharder
```

Check that they arrived. It lists only the names, never the values:

```sh
fly secrets list -a ana-aimharder
```

Keep `aimharder.env` private, or delete it once everything works: your settings are now stored in Fly.

## Step 9. Start your server

Still inside the project folder:

```sh
fly deploy -a ana-aimharder
```

This takes a few minutes the first time. Then make sure there is exactly **one** machine; answer `y` if Fly asks:

```sh
fly scale count 1 -a ana-aimharder
```

Open `https://ana-aimharder.fly.dev/healthz` in your browser. You should see:

```json
{"status":"ok"}
```

If not, see [Troubleshooting](#troubleshooting).

## Step 10. Connect Claude

On [claude.ai](https://claude.ai), in a browser:

1. Open **Customize → Connectors**.
2. Click **Add custom connector**.
3. Enter a name, such as `AimHarder`, and the URL `https://ana-aimharder.fly.dev/mcp`. Note the `/mcp` at the end.
4. If Claude asks how it should identify itself, choose **Register automatically**.
5. Click **Add**, then **Connect**.
6. A page titled **Authorize AimHarder MCP** opens. Type your owner secret and click **Authorize**.

The connector now works on claude.ai, in the desktop app and in the **mobile app**, with nothing more to set up on the phone. In a chat, check that it's switched on under **+ → Connectors**.

## Step 11. Connect ChatGPT (optional)

On [chatgpt.com](https://chatgpt.com), in a browser:

1. Open **Settings → Apps** (sometimes called *Apps & Connectors*), then **Advanced settings**, and turn on **Developer mode**. If you don't see it, your plan doesn't include it.
2. Back in **Settings → Apps**, click **Create app**.
3. Fill in a name (`AimHarder`), a short description, the URL `https://ana-aimharder.fly.dev/mcp` and **OAuth** as authentication. Leave client ID and secret empty.
4. Confirm that you trust the app and click **Create**.
5. On the **Authorize AimHarder MCP** page, type your owner secret and click **Authorize**.

To use it, open a new chat, choose **+ → Developer mode** and select the app. Mention it by name in your message ("With AimHarder, …"), or ChatGPT may not use it.

## Step 12. Try it

Start with questions that only read:

- "Which classes are there tomorrow?"
- "What's today's workout?"
- "Who is booked in today's 14:00 CROSS?"
- "When am I booked this week?"
- "What's my Back Squat 1RM?"

Then try a change, such as "Book tomorrow's 14:00 CROSS". The assistant first shows you exactly what it will do. **Nothing happens until you confirm.** Afterwards it checks AimHarder again and tells you whether it worked.

The first message after a long pause can take a few seconds while your server wakes up.

---

## Everyday tasks

### Change a setting

Use `fly secrets set` with the name and the new value. Your server restarts by itself.

**macOS or Linux** (single quotes around values with `{ }`):

```sh
fly secrets set -a ana-aimharder AIMHARDER_WORKOUT_CLASS='{"undergroundrv":"CROSS"}'
```

**Windows (PowerShell)**: put the whole setting in single quotes:

```powershell
fly secrets set -a ana-aimharder 'AIMHARDER_WORKOUT_CLASS={"undergroundrv":"CROSS"}'
```

You can also edit `aimharder.env` and repeat [step 8](#step-8-send-your-settings-to-fly).

### Get a newer version

Download the ZIP again (step 3), go into the new folder and run `fly deploy -a ana-aimharder`. Your settings stay in Fly.

If you keep your own copy of the project on GitHub (a *fork*), it can deploy itself after every change: see [Deploy automatically from GitHub](remote.md#deploy-automatically-from-github).

### Disconnect every device

Change your owner secret. Every connected Claude or ChatGPT stops working until you connect it again with the new secret.

```sh
fly secrets set -a ana-aimharder MCP_OWNER_SECRET=your-new-secret
```

### Turn it off or delete it

Pause it, with nothing running and no cost for running machines:

```sh
fly scale count 0 -a ana-aimharder
```

Turn it back on with `fly scale count 1 -a ana-aimharder`. Delete it completely, settings included:

```sh
fly apps destroy ana-aimharder
```

Also remove the connector in Claude or the app in ChatGPT.

---

## Troubleshooting

To see what your server is saying, run this and keep it open while you retry. Press Ctrl+C to stop.

```sh
fly logs -a ana-aimharder
```

Messages starting with `INVALID_…` mean a setting is wrong. The message says which one.

| What you see | What to do |
| --- | --- |
| `INVALID_HTTP_CONFIGURATION` | Check `MCP_PUBLIC_URL` (starts with `https://`, no `/mcp`, no `/` at the end) and that `MCP_OWNER_SECRET` has at least 16 characters. |
| `INVALID_CONFIGURATION` | `AIMHARDER_USERNAME` or `AIMHARDER_PASSWORD` is missing or empty, or a simple setting such as `AIMHARDER_DEFAULT_GYM` or `AIMHARDER_REQUIRE_BOOKING_CONFIRMATION` has a value it doesn't accept. |
| `INVALID_TIME_ZONE_CONFIGURATION`, `INVALID_BOOKING_PLAN_CONFIGURATION` or another `INVALID_…` | That setting has a typo. Check it's on one line, has no quotes around the value, keeps the `"` inside `{ }`, and uses two-digit hours (`09:30`). |
| `/healthz` doesn't load | Wait a minute and retry. If it still fails, read `fly logs`. |
| `fly deploy` fails while "Building image" | Fly's build service had a problem. Retry later. If you have [Docker Desktop](https://www.docker.com/products/docker-desktop/) running, `fly deploy -a ana-aimharder --local-only` builds on your computer instead. |
| `Error: … missing an app name` | Add `-a ana-aimharder` to the command, or run it inside the project folder. |
| The authorize page says **Wrong owner secret** | Copy the secret again from your password manager, with no spaces at either end. |
| **Too many failed attempts** | Wait 15 minutes and try again. |
| ChatGPT shows *Unregistered redirect_uri* or *redirect_uris must be…* | Add the address from the error to `MCP_OAUTH_REDIRECT_URIS` with `fly secrets set` (see [Change a setting](#change-a-setting)), then connect again. |
| `AUTHENTICATION_FAILED` when you ask something | AimHarder rejected the email or password. Fix them with `fly secrets set`. |
| Booking says a time zone is required | Add `AIMHARDER_GYM_TIME_ZONES` (step 7). |

## Security in short

- Your owner secret is the key to your server. Anyone who has it can connect an assistant that acts on your AimHarder account. Keep it in a password manager and change it if you think someone has seen it.
- Your AimHarder password lives only in Fly's encrypted settings and in your server's memory. It never appears in answers, errors or logs.
- Class names, workout notes and other members' names come from AimHarder. The assistant treats them as data, never as instructions. Other members' names are personal data: use them only for yourself.

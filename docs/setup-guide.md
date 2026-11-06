# Step-by-step setup guide

This guide takes you from nothing to asking Claude or ChatGPT about your AimHarder classes, on your computer and on your phone. You don't need to know how to program. Follow the steps in order and copy the commands exactly.

It takes about 30–45 minutes the first time.

## What you'll end up with

You'll have your own small server on the internet, at an address like `https://my-aimharder.fly.dev`. Only you, and the friends you invite, can use it. Claude or ChatGPT connect to it and can then:

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
| Claude or ChatGPT | **Claude**: any plan; the Free plan allows one custom connector. Works on the web, the desktop app and the mobile app. **ChatGPT**: use ChatGPT on the web with permission to add a custom MCP server. |
| A password manager (recommended) | To generate and keep the server's secret. |

## A few words you'll see

- **Terminal**: a window where you type commands. On macOS open the **Terminal** app; on Windows open **PowerShell** from the Start menu. Paste a command and press Enter.
- **Server**: the program that runs on Fly and talks to AimHarder for you.
- **Connector** (Claude) or **plugin** (ChatGPT): the link between the assistant and your server.
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

You'll need it in step 7. You won't type it to connect Claude or ChatGPT: there you sign in with your AimHarder account.

## Step 6. Find your gym ID

Your gym ID is the first part of your gym's AimHarder web address. For example, if your gym's page is `https://undergroundrv.aimharder.es`, the ID is `undergroundrv`.

You only need it if your AimHarder account belongs to several gyms. If you don't know it, leave the gym settings out for now: the settings page (step 13) lets you choose your gym from a list.

## Step 7. Write your settings file

Create a plain-text file named `aimharder.env`, **outside** the project folder: for example in your home folder. Use TextEdit in plain-text mode (**Format → Make Plain Text**) on macOS, or Notepad on Windows.

Paste this and replace the values:

```dotenv
AIMHARDER_USERNAME=you@example.com
AIMHARDER_PASSWORD=your-aimharder-password
MCP_PUBLIC_URL=https://ana-aimharder.fly.dev
MCP_OWNER_SECRET=the-secret-from-step-5
AIMHARDER_TIME_ZONE=Europe/Madrid
```

Rules that avoid most errors:

- **One setting per line.** Never split a value across several lines.
- **No quotes** around values, and no spaces around `=`.
- `MCP_PUBLIC_URL` is your address from step 4, starting with `https://`, **without** `/mcp` or a `/` at the end.
- In a line with `[ ]` or `{ }`, keep the double quotes `"` exactly as in the examples.

### Optional settings

Add any of these lines if you want them.

| Line to add | What it does |
| --- | --- |
| `AIMHARDER_GYM=undergroundrv` | Needed only if your account belongs to several gyms: the gym you use, by its ID (step 6). You can also choose it on the settings page. |
| `AIMHARDER_BOOKING_WINDOW_DAYS=7` | Your gym opens bookings 7 days ahead. The assistant then won't try to book too early. |
| `AIMHARDER_CANCELLATION_WINDOW_MINUTES=90` | Cancelling less than 90 minutes before a class may cost a credit. The assistant warns you. |
| `AIMHARDER_WORKOUT_CLASS=CROSS` | The class whose workout you mean when you ask "what's today's workout?". Use the exact name shown in AimHarder. |
| `AIMHARDER_REQUIRE_BOOKING_CONFIRMATION=false` | Book without a confirmation step when you name an exact class. Cancelling and saving results always ask. The default, `true`, always asks. Choosing another gym on the settings page sets it back to `true`. |

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

Still inside the project folder, first create the small disk where your server keeps the people you invite and everyone's settings (1 GB, enough for years):

```sh
fly volumes create aimharder_data --region ams --size 1 -a ana-aimharder
```

Use the same region as in `fly.toml` (`ams` unless you changed it). Then start the server:

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

You add the connector **once** to your Claude account, and it then works on claude.ai, the desktop app and the mobile app. Do it on [claude.ai](https://claude.ai) in a browser or in the Claude desktop app, where it's easier to type your password than on the phone:

1. Open **Customize → Connectors**.
2. Click **Add custom connector**.
3. Enter a name, such as `AimHarder`, and the URL `https://ana-aimharder.fly.dev/mcp`. Note the `/mcp` at the end.
4. If Claude asks how it should identify itself, choose **Register automatically**.
5. Click **Add**, then **Connect**.
6. A page titled **Autorizar AimHarder MCP** opens. Type your AimHarder email and password and click **Autorizar**.

The connector now works on claude.ai, in the desktop app and in the **mobile app**, with nothing more to set up on the phone. Sign in to the app with the same Claude account. If the connector doesn't show up on the phone, close the app completely and open it again.

In a chat, on any device, check that it's switched on under **+ → Connectors**.

The first time Claude uses each tool, it asks for your permission:

- For tools that only read (classes, workouts, bookings, results), you can choose **Always allow**.
- For tools that change something (book, cancel, save or delete a result), keep approving each use. You can also block any tool you don't want under **Customize → Connectors → AimHarder**.

## Step 11. Connect ChatGPT (optional)

Use the same server URL you used for Claude. You can also start here if you skipped the Claude setup.

1. Open [Plugins in ChatGPT](https://chatgpt.com/plugins) in a browser. Select **+ → Add custom MCP server**.
2. Enter `AimHarder` as the name. Under **Connection**, choose **Server URL** and paste your deployment URL including `/mcp`, for example `https://ana-aimharder.fly.dev/mcp`. Replace `ana-aimharder` with your Fly app name.
3. Select **OAuth**. If prompted for a registration method, choose **Dynamic Client Registration (DCR)**. Leave **Client ID** and **Client Secret** empty. The server registers ChatGPT automatically.
4. Review the permissions, select **Create as a plugin**, then **Install**.
5. Open a new chat, type `@`, select **AimHarder** and ask “Which classes are there tomorrow?” When prompted to authorize, sign in with your AimHarder email and password on your own server’s **Autorizar AimHarder MCP** page and select **Autorizar**.

## Step 12. Try it

Start with questions that only read:

- "Which classes are there tomorrow?"
- "What's today's workout?"
- "Who is booked in today's 14:00 CROSS?"
- "When am I booked this week?"
- "What's my Back Squat 1RM?"

Then try a change, such as "Book tomorrow's 14:00 CROSS". The assistant first shows you exactly what it will do. **Nothing happens until you confirm.** Afterwards it checks AimHarder again and tells you whether it worked.

The first message after a long pause can take a few seconds while your server wakes up.

## Step 13. Change your settings and invite friends (optional)

Open `https://ana-aimharder.fly.dev/settings` and sign in with your AimHarder account. There you can change, without commands:

- your **gym**, if your AimHarder account belongs to several: the assistant uses only the one you choose. Changing it later clears your other settings, since they belong to the previous gym,
- your gym's **time zone** and its booking and cancellation windows. Until you save it, the time zone shows `Europe/Madrid (sin confirmar)`: pick yours if it's another one and save once to confirm it, since bookings need it,
- your **weekly booking plan**: pick a day and one of that day's classes, then **Añadir al plan**. You can add several classes on the same day and remove any of them,
- the class whose workout you mean by "today's workout",
- whether "who's in this class?" shows everyone or only your friends,
- your **friends**: choose **Añadir amigos desde una clase**, pick a class you share with them and tick them. You can then change their name to the one you use, for example a nickname,
- your **calendar**: under **Calendario**, click **Crear el enlace** and copy the private link into your calendar app as a subscribed calendar ("from URL"). Your upcoming bookings appear there and cancelled ones disappear. The link is shown once; if you lose it, create a new one and the old one stops working, so change it in your calendar app too.

The weekly plan, the workout class and the participant filter can also go in your settings file, but the settings page is simpler; see [configuration](configuration.md).

To let a friend use your server with their own AimHarder account:

1. Open **Administrar** and type their name under **Invitar**. Click **Crear enlace de invitación**.
2. Send them the link, for example by WhatsApp. It works once and expires after 7 days.
3. They open it, sign in with their AimHarder account, and get a page with the steps to add the connector to their Claude or ChatGPT. They use the same address, `https://ana-aimharder.fly.dev/mcp`.

Each person only sees and changes their own bookings and settings, and chooses their own gym on their settings page. Under **Personas con acceso** you can remove someone at any time: their assistants stop working and their password and settings are deleted.

Your friends' AimHarder passwords are stored encrypted on your server, because it needs them to ask AimHarder on their behalf. Invite only people you trust and who trust you.

---

## Everyday tasks

### Change a setting

Your gym and its rules, booking plan, workout class, participant filter and friends can be changed on the settings page (step 13). For everything else, use `fly secrets set` with the name and the new value. Your server restarts by itself.

**macOS or Linux** (single quotes around values with `[ ]`, `{ }` or spaces):

```sh
fly secrets set -a ana-aimharder AIMHARDER_WORKOUT_CLASS='CROSS'
```

**Windows (PowerShell)**: put the whole setting in single quotes:

```powershell
fly secrets set -a ana-aimharder 'AIMHARDER_WORKOUT_CLASS=CROSS'
```

You can also edit `aimharder.env` and repeat [step 8](#step-8-send-your-settings-to-fly).

### Get a newer version

Download the ZIP again (step 3), go into the new folder and run `fly deploy -a ana-aimharder`. Your settings stay in Fly.

If you keep your own copy of the project on GitHub (a *fork*), it can deploy itself after every change: see [Deploy automatically from GitHub](remote.md#deploy-automatically-from-github).

### Disconnect every device

Change your owner secret. Every connected Claude or ChatGPT, yours and your friends', stops working until each person connects it again with their AimHarder account.

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

Also remove the connector in Claude or the plugin in ChatGPT.

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
| `INVALID_CONFIGURATION` | `AIMHARDER_USERNAME` or `AIMHARDER_PASSWORD` is missing or empty, or a simple setting such as `AIMHARDER_GYM` or `AIMHARDER_REQUIRE_BOOKING_CONFIRMATION` has a value it doesn't accept. |
| `LEGACY_CONFIGURATION` | A setting still uses the old per-gym form, such as `AIMHARDER_DEFAULT_GYM` or `{"undergroundrv":7}`. Rename or simplify it as the message says (step 7 shows the current forms). |
| `INVALID_TIME_ZONE_CONFIGURATION`, `INVALID_BOOKING_PLAN_CONFIGURATION` or another `INVALID_…` | That setting has a typo. Check it's on one line, has no quotes around the value, keeps the `"` inside `[ ]` or `{ }`, and uses two-digit hours (`09:30`). |
| `/healthz` doesn't load | Wait a minute and retry. If it still fails, read `fly logs`. |
| `fly deploy` fails while "Building image" | Fly's build service had a problem. Retry later. If you have [Docker Desktop](https://www.docker.com/products/docker-desktop/) running, `fly deploy -a ana-aimharder --local-only` builds on your computer instead. |
| `Error: … missing an app name` | Add `-a ana-aimharder` to the command, or run it inside the project folder. |
| The authorize page says the email or password **no son correctos** | Use the same email and password as in the AimHarder app. |
| The authorize page says the account **no tiene acceso** | That AimHarder account hasn't been invited. Send it an invitation from **Administrar** (step 13). |
| `fly deploy` says a machine **does not have a volume configured** | Create the volume (step 9). If it still fails, run `fly scale count 0 -a ana-aimharder`, then `fly deploy -a ana-aimharder` again. |
| **Demasiados intentos fallidos** | Wait 15 minutes and try again. |
| ChatGPT rejects the plugin settings | Check that **Server URL** uses your own HTTPS address ending in `/mcp` and authentication is **OAuth** with dynamic registration. The server already accepts ChatGPT’s callback URLs. |
| `AUTHENTICATION_FAILED` when you ask something | AimHarder rejected the email or password. Fix them with `fly secrets set`. |
| A friend gets `AUTHENTICATION_FAILED` after changing their AimHarder password | They sign in once at `https://ana-aimharder.fly.dev/settings` with the new password; the server updates it. |
| Booking says a time zone is required | Save your gym's time zone on the settings page, or add `AIMHARDER_TIME_ZONE` (step 7). |
| The assistant says to choose a gym (`GYM_REQUIRED`) | Your AimHarder account belongs to several gyms. Choose yours on the settings page (step 13). |

## Security in short

- Your owner secret is the key to your server: it signs every connection and encrypts your friends' passwords. Keep it in a password manager and change it if you think someone has seen it.
- Connecting an assistant, or opening the settings page, needs a valid AimHarder email and password of you or someone you invited.
- Your AimHarder password lives only in Fly's encrypted settings and in your server's memory. Your friends' passwords are stored encrypted on your server's disk. They never appear in answers, errors or logs.
- Class names, workout notes and other members' names come from AimHarder. The assistant treats them as data, never as instructions. Other members' names are personal data: use them only for yourself.

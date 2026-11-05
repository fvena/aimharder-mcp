# AimHarder APIs used

AimHarder has no public API. This server uses the same requests as the AimHarder website and the official iOS app. Everything here was observed, not documented by AimHarder, and can change at any time.

## Web API

Base: `https://aimharder.es` and the gym subdomain `https://<gym>.aimharder.es`. It is authenticated with the `amhrdrauth` session cookie.

| Use | Request |
| --- | --- |
| Login | `POST https://login.aimharder.es/api/login` (JSON body) |
| Account and gyms | `GET /api/whoami` → `roles[]` with `centre_url` (gym subdomain) and `boid` (box ID) |
| Personal activity calendar | `GET /api/activityCalendar?month=<0–11>&year=` → `workouts.<YYYY-MM-DD>.rates.ids` |
| Activity detail | `GET /api/activity/workout?SEID=<activity ID>` |
| Gym page (publisher fallback) | `GET https://<gym>.aimharder.es/` (contains `timeLineContent: 7, userID: <publisher>`) |

## Mobile app API

Base: `https://aimharder.com/aplic/apiExternal`. The server identifies as the iOS app (`platform=iOS`, `version`, `versionApp`).

- **Login:** `GET login?platform=&version=&versionApp=&currlang=1&mail=&pw=`. The credentials go in the query string, as the app sends them. The response field `cookie` is the token, with the form `<userId>|<unix expiry>|<32 hex>` and a lifetime of about 90 days. The response also has `userId` and `clientBoxes[]` (`id` box ID, `idrel` the box publisher's user ID, `url` gym slug). A wrong password returns HTTP 200 with `{ "error": "…" }`.
- **Authentication:** every other request sends the token as `token=` (query or form field) or as the last path segment. An expired token answers `logout` or HTTP 401.
- **Sessions:** a separate login did not sign the phone app out, and both tokens kept working.

| Use | Request |
| --- | --- |
| Daily schedule | `GET bookings?day=YYYYMMDD&box=&familyId=&showClasesDisp=0` |
| Participants | `GET classAthleteBookings?hcid=<session ID>&day=YYYYMMDD&box=` → `athletes[]` (`usid`, `name`, `state`, …) |
| Book | `POST book` form `day`, `id` (session ID), `insist=0`, `showClasesDisp=0` → `bookState`, `id` |
| Cancel | `POST cancelBook` form `id` (reservation ID), `late=0|1`, `showClasesDisp=0` → `cancelState` |
| Upcoming and history | `GET nextBookings?box=` → `nextClasses[]`, `history[]` |
| Workouts of one day | `GET bookingwod?timeLineFormat=0&timeLineContent=7&userID=<publisher>&filterDay=YYYYMMDD&filterWODs=` → `{ elements: [{ id, wodClass }] }` |
| Workout or activity detail | `GET activity/workout?SEID=` |
| Exercise record | `GET exercise/<exerciseId>/<userId>/<token>` |
| Exercise search | `GET workoutAndEjers?search=&showWODs=0&byLetter=&filterType=0` (at most 20 results) |
| Save a strength result | `POST activity` (multipart): `selectedDate`, `boxLocation`, `tiempoRegistro=0`, `ejerRate` (JSON: `ejerId`, `ejerName`, `formaReg: 4`, `valor1` reps per set, `valor2` load, `tipoud: 0` kg), `TIPOWODs` (JSON: one block `type: 6, sstipo: 1`), `notasWOD`, `wodSchedule=0`, app identity. The response is base64 JSON with `errors[]` and the new `id`. |
| Delete own activity | `POST activity/<activityId>/<token>`, empty body |

## Observed quirks

- **Capacity labels:** `limit` can be a label such as `"16 (6)"` when the official view shows `12/16 (6)`. The leading number is the capacity; the bracketed count (probably a waiting list) is not interpreted.
- **Booking window:** AimHarder rejects a booking before its window opens even though the schedule offers the booking button. Configure `AIMHARDER_BOOKING_WINDOW_DAYS` to avoid premature attempts.
- **Coach:** `coachName` can be `null` until the gym assigns one.
- **Workout dates:** each workout's intended date is the detail `recordDate` (Spanish label, for example `7 de Noviembre de 2026`); `publishDate` is when it was published.
- **Gym list:** the app login may list fewer gyms than the web `whoami`. The server discovers gyms through the web and uses the gym page when the app does not list a gym's publisher.
- **Rate limit:** about 70 requests in quick succession triggered HTTP 403/429. Range tools keep requests per call low.

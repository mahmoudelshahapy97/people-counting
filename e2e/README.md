# End-to-end tests

Playwright driving the operator console in a real browser, against the real
stack: nginx serving the built bundle, FastAPI behind it, Postgres, MinIO and
mediamtx beside it, and the real people detector counting a real RTSP stream.
Nothing is mocked. When these pass, the wiring works — not just the React
components.

## Running

```bash
docker compose up -d --build                    # the whole stack
docker compose exec -T postgres psql -U peoplecount -d peoplecount_db < database/seed.sql
./e2e/run.sh                                    # whole suite
./e2e/run.sh tests/04-live-counting.spec.js     # one file
```

`run.sh` executes the tests inside `mcr.microsoft.com/playwright`, so nothing
has to be installed locally beyond Docker — the image already carries the
browsers and their system libraries. By default it runs with `--network host`,
which is why `BASE_URL` defaults to `http://localhost:8083` (the console's
published port) rather than a compose service name.

To run against a stack that publishes no ports, for example a second copy
started under its own project name next to the real one, join its network
instead:

```bash
E2E_NETWORK=<project>_default BASE_URL=http://web MAILPIT_URL=http://mailpit:8025 ./e2e/run.sh
```

Results land in:

| Path | What |
| --- | --- |
| `playwright-report/` | HTML report — `npx playwright show-report` |
| `results.json` | machine-readable summary |
| `test-results/` | screenshots, video and traces for failures |
| `artifacts/` | the demo tour's screenshots and video (spec 06) |

## Mail

Two specs read mail back: the password reset (00) and the occupancy alert
(04). They need an SMTP sink the API sends to and the suite can query.
`compose.mailpit.yml` adds one:

```bash
docker compose -f docker-compose.yml -f e2e/compose.mailpit.yml up -d --build
MAILPIT_URL=http://mailpit:8025 E2E_NETWORK=<project>_default BASE_URL=http://web ./e2e/run.sh
```

Without `MAILPIT_URL` both specs skip themselves rather than fail.

## The seed is a fixture, and one camera is live

`database/seed.sql` loads four cameras with 14 days of synthetic samples,
violations and alerts in all four statuses. Spec 03 asserts against those rows
and does not need the detector at all, so it is fast and deterministic. It
`test.skip`s itself when there are no alerts, with a message naming the seed.

One seeded camera, **Main Entrance**, is enabled and reads
`rtsp://mediamtx:8554/people`, a crowd clip that always holds more people than
its maximum of 15. The stream manager starts its worker on its own. Spec 04
waits for that worker and asserts on what it really produces: a live count over
the limit, samples stored on their interval, an alert with an annotated JPEG
snapshot in MinIO, and the alert mail. On a GPU the first count arrives within
seconds of the RTSP connect; on CPU the first forward pass alone can take tens
of seconds, which the timeouts allow for.

Because that worker keeps raising real alerts next to the seeded ones, spec 03
never assumes which kind of alert it picked. An alert with `has_frame` came
from the worker and must show its snapshot; one without must say there is none.

## Auth: one login, shared by everything

Every route but `/health` and `/login` needs a session (see the backend's
Auth section in `../backend/README.md`). Rather than have every file log in,
`global.setup.js` runs once as a Playwright *setup project*: it logs in as the
bootstrap admin through the real `/login` page, saves the browser's
storageState (the access/refresh tokens `localStorage` holds, plus the
httpOnly cookie the image routes accept) to `.auth/admin.json`, and creates one
operator and one viewer account for role assertions. `chromium` (the project
`01`–`05` and `07` run under) starts every test already signed in with that
state.

The bare `request` fixture used for direct API assertions is a *separate*
context from the browser. It only inherits storageState's cookie, and the JSON
API requires the bearer header (the cookie is accepted on the image routes
only, see `get_image_viewer` in `backend/app/api/deps.py`). Anywhere a spec
calls `request.get/post/patch/delete` directly, it passes
`{ headers: authHeaders() }` (`tests/helpers.js`), which reads the token back
out of `.auth/admin.json`.

`00-auth.spec.js` runs in its own project, signed out on purpose: the login
page itself, a wrong password, the redirect-and-return-to flow, and what a
viewer and an operator can and cannot reach. It still depends on the setup
project, for the operator/viewer accounts.

## The specs are one story

`playwright.config.js` runs a single worker, files in order, and they share
state:

| File | What it covers |
| --- | --- |
| `00-auth.spec.js` | Login (by username or email), bad credentials, redirects, role boundaries (an operator tunes limits but cannot edit a camera), forgot password. Runs signed out |
| `01-shell.spec.js` | Health, the alerts and analytics APIs, every route renders, nav, 404, `/events` redirect, theme toggle |
| `02-camera-lifecycle.spec.js` | Register a camera through the form, min/max validation, the limits dialog, start and stop its worker |
| `03-observability.spec.js` | Alert list and filters, alert detail, triage with the action taken, count history with filters, chart and CSV, system page |
| `04-live-counting.spec.js` | The seeded live camera: real count over its limit, dashboard tile, stored samples, alert snapshot, alert mail, analytics charts |
| `05-teardown.spec.js` | Edit, stop, delete, and check the seeded cameras survived |
| `06-demo-walkthrough.spec.js` | Not a correctness check: a recorded tour of every screen, as admin then as viewer (`demo` project) |
| `07-workspaces.spec.js` | Create a workspace, a camera in it, switch to it, a non-member is shut out, delete it |

Anything that has to survive between files is re-read from the API
(`findCamera`), never kept in a module variable: each spec file gets a fresh
module registry.

They are ordered rather than parallel because two files racing would fight over
the camera-name uniqueness constraint and over the same seeded alert, which
spec 03 acknowledges and puts back.

## Conventions worth keeping

**`collectPageProblems` runs on most specs.** A React page that throws still
renders its shell, so a passing visual assertion can hide a broken component.
Console errors are collected and asserted empty at the end. 404s and 503s from
image endpoints are filtered out: an alert with no stored snapshot and a camera
whose source is down are states the UI handles on purpose.

**Assertions check the API as well as the page.** A form that navigates
correctly but wrote nothing is the failure mode worth catching, so the write
specs read the row back. `02` in particular checks that a blank minimum is
stored as no minimum, and a blank override is *absent* from `settings`, not
stored as `0`.

**The suite cleans up after itself.** The E2E camera has a fixed name and
`01` removes one left by an interrupted run; `03` returns the alert it
triaged to OPEN; `05` deletes the camera and checks that the seeded cameras
are still there, since deleting a camera cascades to its samples and alerts.

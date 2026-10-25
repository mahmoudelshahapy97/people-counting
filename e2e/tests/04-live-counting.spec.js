import { expect, test } from "@playwright/test";
import { SEED, authHeaders, collectPageProblems, latestMailTo, waitForApi } from "./helpers.js";

/**
 * The detection path itself, end to end: the seeded Main Entrance reads a
 * crowd clip from mediamtx, its worker counts the people in it with the real
 * detector, stores samples, and — since the clip holds more people than the
 * camera's maximum of 15 — raises an alert with an annotated snapshot and
 * mails it. Nothing is mocked, so these are the slow specs; on a GPU the
 * first count arrives within seconds of the worker connecting.
 */
test.describe.configure({ mode: "serial" });

async function liveRow(request) {
  const response = await request.get("/api/v1/counts/live", { headers: authHeaders() });
  const { data } = await response.json();
  return data.cameras.find((camera) => camera.camera_id === SEED.cameraId);
}

test.beforeAll(async ({ request }) => {
  const row = await liveRow(request);
  test.skip(!row?.enabled, "the seeded Main Entrance is missing or disabled — load database/seed.sql");
});

test("the seeded camera's worker connects and counts people", async ({ request }) => {
  // The supervisor starts enabled cameras on its own; this only waits for it.
  const row = await waitForApi(
    request,
    "/counts/live",
    (body) => {
      const camera = body.data.cameras.find((c) => c.camera_id === SEED.cameraId);
      return camera?.live && camera.person_count > 0;
    },
    { timeout: 100_000 }
  ).then((body) => body.data.cameras.find((c) => c.camera_id === SEED.cameraId));

  expect(row.state).toBe("running");
  // The clip is a crowd; anything at or under the maximum would mean the
  // detector or the counting region is not doing its job.
  expect(row.person_count).toBeGreaterThan(SEED.cameraMax);
  expect(row.violation).toBe("greater_than");
});

test("the camera page shows the live count against its limit", async ({ page }) => {
  const problems = collectPageProblems(page);
  await page.goto(`/cameras/${SEED.cameraId}`);

  const count = page.getByTestId("live-count");
  await expect(count).toHaveText(/^\d+$/, { timeout: 45_000 });
  expect(Number(await count.textContent())).toBeGreaterThan(SEED.cameraMax);
  await expect(page.getByText(`Max ${SEED.cameraMax}`, { exact: true })).toBeVisible();

  // A running worker serves its annotated MJPEG stream, authenticated by the
  // cookie; the <img> having a size means frames actually arrived.
  const view = page.getByRole("img", { name: `Live view from ${SEED.cameraName}` });
  await expect(view).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => view.evaluate((img) => img.naturalWidth), { timeout: 30_000 }).toBeGreaterThan(0);

  expect(problems, problems.join("\n")).toEqual([]);
});

test("the dashboard tile turns live and out of limits", async ({ page }) => {
  await page.goto("/");
  const tile = page.getByRole("link").filter({ hasText: SEED.cameraName }).first();
  await expect(tile.getByText("Live", { exact: true })).toBeVisible({ timeout: 45_000 });
  await expect(tile.getByText(`Max ${SEED.cameraMax}`, { exact: true })).toBeVisible();
  await expect(tile.getByText(`Above max ${SEED.cameraMax}`)).toBeVisible();
  // The people-now stat sums the live tiles, so it is at least this camera's count.
  await expect(page.getByText("People now")).toBeVisible();
});

test("the worker stores samples on its interval", async ({ request }) => {
  const since = new Date(Date.now() - 5 * 60_000);
  const body = await waitForApi(
    request,
    `/counts?camera_id=${SEED.cameraId}&per_page=20`,
    (b) => b.samples.filter((s) => new Date(s.captured_at) > since).length >= 2,
    { timeout: 60_000 }
  );
  const recent = body.samples.filter((s) => new Date(s.captured_at) > since);
  expect(recent.every((s) => s.person_count >= 0)).toBe(true);

  // Samples land every sample_interval_s (10 s by default), never in a burst.
  const times = recent.map((s) => new Date(s.captured_at).getTime()).sort();
  for (let i = 1; i < times.length; i += 1) {
    expect(times[i] - times[i - 1]).toBeGreaterThan(3_000);
  }
});

test("going over the maximum raised an alert with an annotated snapshot", async ({ request }) => {
  // Seeded alerts carry no frame, so one that has a frame came from the worker.
  const body = await waitForApi(
    request,
    `/alerts?camera_id=${SEED.cameraId}&per_page=50`,
    (b) => b.alerts.some((alert) => alert.has_frame),
    { timeout: 90_000 }
  );
  const alert = body.alerts.find((a) => a.has_frame);
  expect(alert.threshold_type).toBe("greater_than");
  expect(alert.threshold_value).toBe(SEED.cameraMax);
  expect(alert.person_count).toBeGreaterThan(SEED.cameraMax);

  const frame = await request.get(`/api/v1/alerts/${alert.alert_id}/frame`, {
    headers: authHeaders(),
  });
  expect(frame.ok()).toBeTruthy();
  expect(frame.headers()["content-type"]).toBe("image/jpeg");
  const bytes = await frame.body();
  // A JPEG, and more than a placeholder.
  expect(bytes[0]).toBe(0xff);
  expect(bytes[1]).toBe(0xd8);
  expect(bytes.length).toBeGreaterThan(10_000);
});

test("the alert was mailed to the workspace's admins", async ({ request }) => {
  test.skip(!process.env.MAILPIT_URL, "MAILPIT_URL is not set — the stack's mail is not observable");
  const me = await (await request.get("/api/v1/auth/me", { headers: authHeaders() })).json();
  const text = await latestMailTo(request, me.email, {
    subject: `HIGH OCCUPANCY ALERT - ${SEED.cameraName}`,
    timeout: 60_000,
  });
  expect(text).toContain(SEED.cameraName);
  expect(text).toContain(`more than ${SEED.cameraMax}`);
});

test("the analytics page charts the stored history", async ({ page }) => {
  const problems = collectPageProblems(page);
  await page.goto("/analytics");
  await expect(page.getByRole("heading", { name: "Analytics", level: 5 })).toBeVisible();

  for (const label of ["Average people", "Peak", "Violations", "Alerts"]) {
    await expect(page.getByText(label, { exact: true }).first()).toBeVisible({ timeout: 45_000 });
  }
  for (const title of ["Occupancy", "People over time, by camera", "When it is busy"]) {
    await expect(page.getByText(title, { exact: true })).toBeVisible();
  }
  // chart.js draws into a canvas; a card with no data renders none.
  await expect(page.locator("canvas").first()).toBeVisible();

  expect(problems, problems.join("\n")).toEqual([]);
});

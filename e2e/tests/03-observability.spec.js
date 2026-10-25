import { expect, test } from "@playwright/test";
import { SEED, authHeaders, collectPageProblems } from "./helpers.js";

/**
 * Reading what the system holds: alerts and their triage, the count history,
 * and the workers & config page. Everything here is asserted against
 * database/seed.sql's 14 days of synthetic history, not against the live
 * worker, so it stays deterministic; spec 04 covers real counting.
 */
test.describe.configure({ mode: "serial" });

async function openAlert(request) {
  const response = await request.get("/api/v1/alerts", {
    headers: authHeaders(),
    params: { status: "OPEN", per_page: 1 },
  });
  const { alerts = [] } = await response.json();
  return alerts[0] || null;
}

test.beforeAll(async ({ request }) => {
  const response = await request.get("/api/v1/alerts?per_page=1", { headers: authHeaders() });
  const body = await response.json();
  test.skip(
    !body.total,
    "no alerts in the database — load database/seed.sql to run the observability specs"
  );
});

test("the alert list renders the seeded alerts", async ({ page }) => {
  const problems = collectPageProblems(page);
  await page.goto("/alerts");
  await expect(page.getByRole("heading", { name: "Alerts", level: 5 })).toBeVisible();

  // The seed raises dozens of alerts across all four statuses.
  await expect(page.getByRole("row").nth(5)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("link", { name: SEED.cameraName }).first()).toBeVisible();
  expect(problems, problems.join("\n")).toEqual([]);
});

test("the status filter lives in the URL and narrows the list", async ({ page, request }) => {
  await page.goto("/alerts?status=FALSE_POSITIVE");
  await expect(page.getByRole("row").nth(1)).toBeVisible({ timeout: 30_000 });

  // Every visible status chip is the filtered one.
  const body = page.getByRole("rowgroup").nth(1);
  await expect(body.getByText("Open", { exact: true })).toHaveCount(0);
  await expect(body.getByText("False Positive").first()).toBeVisible();

  const api = await request.get("/api/v1/alerts", {
    headers: authHeaders(),
    params: { status: "FALSE_POSITIVE", per_page: 100 },
  });
  const { alerts } = await api.json();
  expect(alerts.every((alert) => alert.status === "FALSE_POSITIVE")).toBe(true);
});

test("a filter that matches nothing offers to clear itself", async ({ page }) => {
  // A camera id that is not one: an empty list must not be a dead end.
  await page.goto("/alerts?camera_id=00000000-0000-4000-8000-000000000000");
  await expect(page.getByText("Nothing matches these filters")).toBeVisible({ timeout: 30_000 });
  // The filter bar has a "Clear filters" too; the one asserted here is the
  // empty state's, the last on the page.
  await page.getByRole("button", { name: "Clear filters" }).last().click();
  await expect(page).toHaveURL(/\/alerts$/);
});

test("an alert's detail shows the count, the limit and the camera", async ({ page, request }) => {
  const alert = await openAlert(request);
  test.skip(!alert, "no OPEN alert in the seed window");
  await page.goto(`/alerts/${alert.alert_id}`);

  const people = `${alert.person_count} ${alert.person_count === 1 ? "person" : "people"}`;
  const kind = alert.threshold_type === "greater_than" ? "High" : "Low";
  await expect(
    page.getByRole("heading", { name: `${kind} occupancy: ${people}`, level: 5 })
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("link", { name: alert.camera_name })).toBeVisible();
  // Seeded alerts store no snapshot, and the panel says so instead of showing
  // a broken image; one the live worker raised shows its annotated frame.
  if (alert.has_frame) {
    const frame = page.getByRole("img", { name: `Annotated frame: ${people}` });
    await expect.poll(() => frame.evaluate((img) => img.naturalWidth)).toBeGreaterThan(0);
  } else {
    await expect(page.getByText("No snapshot stored for this alert")).toBeVisible();
  }
});

test("acknowledging an alert records the action taken", async ({ page, request }) => {
  const alert = await openAlert(request);
  test.skip(!alert, "no OPEN alert in the seed window");
  await page.goto(`/alerts/${alert.alert_id}`);

  await page.getByRole("button", { name: "Acknowledge" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Action taken").fill("E2E: steward sent to the entrance");
  await dialog.getByRole("button", { name: "Acknowledge" }).click();

  await expect(page.getByText("Alert marked acknowledged.")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("E2E: steward sent to the entrance")).toBeVisible();
  // The button for the status it is now in is disabled, the others are not.
  await expect(page.getByRole("button", { name: "Acknowledge" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Resolve" })).toBeEnabled();

  const response = await request.get(`/api/v1/alerts/${alert.alert_id}`, {
    headers: authHeaders(),
  });
  const stored = await response.json();
  expect(stored.status).toBe("ACKNOWLEDGED");
  expect(stored.action_taken).toBe("E2E: steward sent to the entrance");
  expect(stored.acknowledged_at).toBeTruthy();

  // Put it back so a re-run finds the same OPEN alert.
  await request.patch(`/api/v1/alerts/${alert.alert_id}/status`, {
    headers: authHeaders(),
    data: { status: "OPEN" },
  });
});

test("the count history lists samples and filters by camera", async ({ page, request }) => {
  const problems = collectPageProblems(page);
  await page.goto("/history");
  await expect(page.getByRole("heading", { name: "Count history", level: 5 })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "People" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("row").nth(5)).toBeVisible();

  await page.getByLabel("Cameras").click();
  await page.getByRole("option", { name: SEED.deskName }).click();
  await page.keyboard.press("Escape");
  const rows = page.getByRole("rowgroup").nth(1).getByRole("row");
  await expect(rows.first()).toContainText(SEED.deskName, { timeout: 20_000 });
  for (const name of SEED.cameraNames.filter((n) => n !== SEED.deskName)) {
    await expect(rows.filter({ hasText: name })).toHaveCount(0);
  }

  // The chart view reads the same filters.
  await page.getByRole("button", { name: "Chart" }).click();
  await expect(page.getByText("People over time")).toBeVisible({ timeout: 20_000 });

  // And the CSV export carries the filtered rows.
  const csv = await request.get("/api/v1/counts/export.csv", {
    headers: authHeaders(),
    params: { camera_id: SEED.deskId },
  });
  expect(csv.ok()).toBeTruthy();
  const lines = (await csv.text()).trim().split("\n");
  expect(lines.length).toBeGreaterThan(1);
  expect(lines.slice(1).every((line) => line.includes(SEED.deskName))).toBe(true);

  expect(problems, problems.join("\n")).toEqual([]);
});

test("the system page reports workers and the config in force", async ({ page }) => {
  const problems = collectPageProblems(page);
  await page.goto("/system");

  await expect(page.getByRole("heading", { name: "Workers & config", level: 5 })).toBeVisible();
  // The value, not the panel caption that also says "connected" — the stat
  // card renders its value as an h4.
  await expect(page.getByRole("heading", { name: "Connected", level: 4 })).toBeVisible({
    timeout: 30_000,
  });

  // The seeded Main Entrance is enabled, so its worker is listed.
  await expect(page.getByRole("row").filter({ hasText: SEED.cameraName })).toBeVisible();

  for (const group of ["Detection", "Counting", "Stream", "Retention"]) {
    await expect(page.getByRole("heading", { name: group, exact: true })).toBeVisible();
  }
  await expect(page.getByText("sample interval s")).toBeVisible();

  expect(problems, problems.join("\n")).toEqual([]);
});

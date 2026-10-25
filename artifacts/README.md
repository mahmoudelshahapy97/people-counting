# Screens

The running console, captured by the Playwright demo tour
([`e2e/tests/06-demo-walkthrough.spec.js`](../e2e/tests/06-demo-walkthrough.spec.js)) against the
full stack with `database/seed.sql` loaded. Main Entrance is the one live camera: the people
detector counts a crowd clip on the GPU, over its limit of 15.

`./e2e/run.sh` writes a fresh set here on every run.

**Video:** [`videos/walkthrough.webm`](videos/walkthrough.webm), the whole tour as admin and then
as a viewer.

## Signing in

| | |
|---|---|
| ![Login](screenshots/01-login-page.png) | ![Wrong password](screenshots/02-login-rejected.png) |
| Login | A wrong password |

## As admin

**Dashboard:** live occupancy per camera against its limits, and the latest alerts.

![Dashboard](screenshots/03-dashboard.png)

**Cameras** and a camera's **live view**: every counted person boxed, the frame red while the
count is over the limit, and the next alert held back by the cooldown.

![Cameras](screenshots/04-cameras-list.png)
![Camera detail](screenshots/05-camera-detail.png)

**Alerts** and an **alert** with the annotated snapshot that raised it.

![Alerts](screenshots/06-alerts-list.png)
![Alert detail](screenshots/07-alert-detail.png)

**Analytics:** occupancy over time, per camera, per floor, by weekday and hour, and threshold
violations.

![Analytics](screenshots/08-analytics.png)

**Count history:** every stored sample, filterable and exportable as CSV.

![Count history](screenshots/09-count-history.png)

**Workers & config:** the running workers and the counting values in force.

![Workers & config](screenshots/10-system-status.png)

**Users**, and the account menu.

![Users](screenshots/11-users-admin-view.png)
![Account menu](screenshots/12-user-menu.png)

## As a viewer

Read-only: no Users or Workspaces pages, and no camera actions.

![Logged out](screenshots/13-logged-out.png)
![Viewer dashboard](screenshots/14-viewer-dashboard.png)
![Viewer cameras](screenshots/15-viewer-cameras-no-management-actions.png)

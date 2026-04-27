## What a job is

A "job" is a scheduled outbound delivery to a list of contacts. The user
configures it via a multi-step form, confirms on a Verify
information screen, and applies it. The system then schedules the job
according to the configured parameters.

## Job lifecycle

A job moves through these statuses, in order:

- `queued` — initial state right after Apply, before scheduling starts.
- `scheduling` — the system is computing per-contact delivery times.
- `scheduled` — scheduling is complete; contacts have planned send times,
  delivery has not started yet.
- `delivering` — contacts are actively being sent.
- `completed` — all scheduled contacts have either been delivered or
  suppressed.
- `failed` — the job aborted before completion. Treat as terminal.

On a healthy deploy the job typically transitions from `queued` →
`scheduling` → `scheduled` within a few minutes.

## Where to navigate

- **Create a job**: from the Jobs table, click the **Schedule job** button
  (top of the page). This opens the scheduling-mode dropdown.
- **View an existing job**: from the Jobs table, click the row for the
  job. Each job has a dedicated detail page.

## Metrics on the job detail page

The job detail page surfaces these counters as plain text:

- **Total contacts** — size of the targeted list.
- **Scheduled** — contacts with a planned delivery time.
- **Suppressed** — contacts excluded from delivery (unsubscribed, bounced,
  filtered by recycling or by target open rate, etc.).
- **Delivered** — contacts already sent.

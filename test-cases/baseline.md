---
name: baseline
description: Single job with conservative parameters; sanity check that scheduling and one observation work end-to-end.
target_type: job
parameters:
  list_id: "smoke-list-100"
  throttling_algorithm: even_distribution
  delivery_window_hours: 24
  target_open_rate: null
expectations:
  scheduling_completes_within_minutes: 5
  expected_status_after_scheduling: scheduled
---

# Baseline test case

Create a job that uses an even-distribution throttling algorithm over a 24-hour
delivery window with no target open rate filter. After creation, observe the
job once and confirm the scheduling phase completed and the job moved to
`scheduled` status.

This is the simplest possible scenario and should always pass on a healthy
deploy.

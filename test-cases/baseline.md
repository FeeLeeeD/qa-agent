---
name: baseline
description: Single job with conservative parameters; sanity check that scheduling and one observation work end-to-end.
target_type: job
parameters:
  job_name_prefix: "test-baseline"
  mode: preview
  list_name: "Test List"
  throttling_option: "Throttle Sending (Even Distribution)"
  delivery_window_hours: 24
  recycle_people: true
  recycle_percentage: 7
expectations:
  scheduling_completes_within_minutes: 5
  expected_status_after_scheduling: scheduled
---

This is the smallest sanity scenario, run after every dev deploy. It is
scheduled in `preview` mode so a baseline run never causes real
deliveries.

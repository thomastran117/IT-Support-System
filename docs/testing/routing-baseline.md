# Routing time: manual baseline versus SmartDesk

This is the method for finding out, by measurement, whether SmartDesk-assisted routing is at least 50%
faster than manual triage. **No measurement has been run yet, so no reduction is claimed** (see
[Results](#results)). The method, the arithmetic and the tooling are in place and tested; the real
manual run is a human activity that has to be done and recorded.

## What is timed

One observation is one ticket's **routing time**:

- **Start:** the ticket's submission time (`tickets.created_at`; for the manual run, the time the ticket
  is handed to the person triaging).
- **End:** the **first approved support-team assignment**: the first `TEAM_ASSIGNED` event. Later
  reassignments never replace it. This is the same boundary as SQL report Q05 and the dashboard's
  "mean time to first routing".
- **Unit:** minutes.
- A ticket that was never routed in the observation period has no end. It is recorded with a blank
  `assigned_at`, **excluded from the mean and counted and disclosed**. It is never treated as zero and
  never as the maximum.

## The two cohorts

| Cohort                 | How it is obtained                                                                                                                                                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Manual (control)**   | A controlled run with SmartDesk's AI suggestion switched off: a named person triages comparable tickets by hand and the clock is read from submission to the moment they confirm the team. Record every ticket handled, including ones that never got a team.            |
| **SmartDesk-assisted** | Real tickets from the database, exported with `export-assisted` (same cohort and first-routing rule as Q05). Optionally restrict to tickets whose AI recommendation was accepted or overridden by a reviewer (`--ai-assisted-only`) to measure only AI-assisted routing. |

Make the cohorts comparable before trusting the result:

- Similar **category mix**. The report prints both mixes and warns when a category's share differs by
  more than 20 percentage points or appears in only one cohort.
- Similar **conditions**: working hours, technician availability and workload. Write these down in the
  run record below.
- The manual triager should not have seen the AI suggestion for those tickets.

## Formula

```
improvement % = (manual mean − SmartDesk mean) / manual mean × 100
```

Means are over **routed** observations only. The verdict (`MET`, `NOT MET` or `INCONCLUSIVE`) uses the
**unrounded** improvement, so display rounding cannot flip it. It is `INCONCLUSIVE` when either cohort has
fewer than 10 routed observations (change with `--min-sample`) or the improvement is undefined. A negative
improvement means assisted routing was slower. The report also prints the median, sample standard
deviation, minimum and maximum, because a mean alone hides spread.

## How to run it

All commands run in `backend/`. The comparison itself needs no database.

```sh
# 1. Manual observations: copy the template and add one row per ticket you timed.
cp ../docs/testing/routing-baseline/manual-observations.template.csv manual.csv

# 2. Assisted observations: raw rows from the database for the observation window (UTC, half-open).
DATABASE_URL=postgres://... npm run baseline:routing -- export-assisted \
  --start 2026-03-01 --end 2026-04-01 --out assisted.csv        # add --ai-assisted-only if wanted

# 3. Compute the comparison from the two files.
npm run baseline:routing -- report --manual manual.csv --assisted assisted.csv \
  --out-md routing-baseline-report.md --out-json routing-baseline-report.json
```

Observation files are plain CSV with the header `observation_id,category,started_at,assigned_at,note`.
Times are ISO-8601 with an offset (for example `2026-03-02T09:00:00Z`). Lines starting with `#` and
blank lines are ignored. Rows that cannot be used (a missing id or category, a bad time, an end before
the start) are listed as invalid in the report instead of disappearing. Duplicate ids stop the run.

**Keep `manual.csv`, `assisted.csv` and the generated report together** (for example in the run's
folder or an attachment to the evidence record). They are the evidence: a reviewer reruns step 3 on the
same two files and must get the same figures. No row is typed into the report by hand.

## Independent check

A second person, who did not run the experiment, should:

1. Open the two CSV files and recompute each mean with a spreadsheet: for each routed row,
   `assigned_at − started_at` in minutes, then the average per cohort.
2. Apply the formula above and compare with the report.
3. Check the unrouted and invalid counts against the files.
4. Rerun step 3 and confirm the output is identical.

The arithmetic module has unit tests with hand-calculated values (including exactly 50%, 37.5%, a
negative improvement, the minimum-sample rule and the rounding edge), and the export is tested against
the seeded fixtures and reproduces Q05 (9 submitted, 6 routed, mean 25.00 minutes). Those tests prove
the method works; they are **not** a measurement of real routing time.

## Limitations

- **Not randomised.** The cohorts come from different times and conditions. Ticket mix, workload,
  time of day and the individual who triages manually can all change the means.
- **Small samples** give wide uncertainty; the report refuses a verdict under the minimum sample size.
- **Seed or demo timestamps are not evidence.** Fixture data exists to test the tooling. Do not export a
  seeded database and report it as a result.
- **One boundary.** Only submission to first approved team is timed, not time to resolution or the
  quality of the routing. Fast routing to the wrong team is not a good outcome; accuracy is measured
  separately (AI evaluation report).
- A result applies to the sample and period measured, not to every future workload.

## Run record

Fill in one block per run and store it with the files.

| Field                                                         | Value         |
| ------------------------------------------------------------- | ------------- |
| Run date and observation window (UTC)                         | _not yet run_ |
| Environment (commit, database, AI provider and model version) | _not yet run_ |
| Manual triager(s) and their experience                        | _not yet run_ |
| Manual conditions (hours, workload, AI suggestion hidden?)    | _not yet run_ |
| Manual sample: observed / routed / unrouted / invalid         | _not yet run_ |
| Assisted sample: observed / routed / unrouted / invalid       | _not yet run_ |
| Evidence files                                                | _not yet run_ |
| Independent reviewer and date                                 | _not yet run_ |

## Results

**Not yet measured.** There is no recorded manual baseline, so SmartDesk's routing improvement is
unknown and the 50% reduction target is **unverified**. Do not state that it was achieved until a run
above produces a `MET` verdict on adequate samples, has been independently recomputed, and its
limitations are stated next to the number.

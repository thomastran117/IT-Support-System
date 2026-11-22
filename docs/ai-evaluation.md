# AI classification evaluation

How we measure whether AI category recommendations are right, and what we can and cannot claim from
the numbers. Code lives in `backend/src/modules/ai/evaluation/`; the command is `npm run eval:ai`.

## What is measured

**Category accuracy** = correct first valid predictions divided by **all** independently labelled cases.

- The prediction for a case is the first valid answer the provider gives (by default one call per case).
- A case with no valid prediction (provider error, unusable answer, no answer) is **wrong** and stays in
  the denominator. Accuracy is never computed over only the answered cases.
- Only the category is scored. A secondary check reports how many valid predictions named a team the
  dataset accepts for the reference category; it is not part of the accuracy figure.

This is the same definition as SQL report **Q07**, which applies it to real labelled tickets in the
database (first valid recommendation per ticket, missing counts as wrong, denominator is all labelled
tickets). An integration test runs both on the seeded fixtures and requires identical counts, and a unit
test checks the hand-calculated `EXPECTED.q07` values (5 labelled, 4 with a recommendation, 2 correct,
40.00%). The offline harness measures a fixed synthetic dataset; Q07 measures production. They agree in
method, not in data. Q08 (acceptance rate) is a different thing: it measures how often technicians
accept suggestions, not whether they are correct.

## Measuring real tickets

Administrators write independent labels through `PUT /api/admin/tickets/:id/classification-label`
(page: `/admin/evaluation`) and read the report at `GET /api/admin/reports/ai-evaluation`. It gives the
overall figure, the same figure per model version, acceptance as a separate measure, and a confusion
summary, each with its denominator. Which model version, how many labelled tickets and how many had no
valid recommendation are all part of the response, so a number is never read without its evidence. The
90% target remains unverified until such a run, on a representative labelled set, reaches it; the
offline dataset below is synthetic and does not substitute for it.

## Dataset

`dataset.ts`, version `1.0.0`.

- **40 synthetic tickets**, 10 for each of Hardware, Software, Network/VPN and Access/Accounts. No real
  people, systems or credentials; a test checks that nothing in the text would be redacted.
- **Independent labels.** Each case has a reference category written by hand with a one-line rationale.
  Nothing reads a model prediction when creating or checking a label, and the harness never sends a
  label, rationale or case id to a provider (a test asserts this). Never generate or "correct" labels from
  AI output.
- **Pinned.** The dataset hash is recorded in every report and pinned in a unit test. Changing any case
  or label changes the hash, which fails the test until `DATASET_VERSION` is bumped and the pin updated,
  so a change cannot slip in unnoticed.
- Retrieval is off (no articles are supplied), so this measures classification from the ticket text alone.

## Prompts and versions

The prompt lives in `prompt.ts` and carries `PROMPT_VERSION`. The SHA-256 of its instructions is pinned
per version in `PROMPT_HASHES`; editing the text without bumping the version fails the run and the
tests. Every report records the provider, the model version(s) the provider reported, the prompt version
and hash, the dataset version and hash, the number of calls, the duration and (if `GIT_SHA` is set) the
commit. Recommendations stored in the database carry the same information in `model_version`
(`<provider>:<model>@prompt-<version>`).

## Running it

```sh
# CI and local: deterministic, offline, free
npm run eval:ai -- --provider baseline --out-md report.md --out-json run.json
npm run eval:ai -- --provider fake

# A real model, in a controlled environment only (see Cost)
AI_PROVIDER=openai AI_API_KEY=... AI_MODEL=... EVAL_ALLOW_LIVE=1 \
  npm run eval:ai -- --provider configured --out-md report.md --out-json run.json
```

Options: `--max-calls N` (calls per case until one is valid), `--limit N` (first N cases only; the
denominator is then N and the report says so), `--out-md`, `--out-json`. The command exits 0 whatever
the score: it reports, it does not gate a build.

- `baseline` is a keyword rule set, **not an AI model**. Its rules were written with this dataset in
  view, so its score is optimistic and is never a benchmark. It exists so CI can run the whole
  pipeline reproducibly.
- `fake` always proposes the first category, so it scores 25% on this balanced dataset (10 of 40). That
  is a useful sanity floor for the harness.
- `configured` uses `AI_PROVIDER`; it sends the synthetic tickets to that service.

## Output

A Markdown report and an optional JSON file: the headline fraction with a 95% interval, the outcome
counts (correct, wrong category, invalid, missing), per-category recall, a confusion matrix (including
INVALID and MISSING columns), every failed prediction with its reason, run details and limits.

## Cost

A live run makes one call per case (40 by default, more with `--max-calls`), each carrying roughly
100 characters of ticket text plus the fixed instructions, and returns at most `AI_MAX_OUTPUT_TOKENS`
tokens. The report prints the number of calls and the characters of ticket text sent. Multiply by the
provider's current prices for the exact figure; prices change, so none are hard-coded here.

## What we can and cannot claim

- **We cannot claim the target of at least 90% accuracy without a measured run of a real model.** No
  such run is in this repository, and no report states that the target was met. The `baseline` and
  `fake` scores say nothing about any model.
- With 40 cases the uncertainty is large: even 39 of 40 (97.5%) has a 95% interval of roughly 87% to
  99.6%. The report states whether the point estimate and the interval's lower bound clear 90%, and
  that a point estimate alone does not establish the target. A convincing claim needs more cases, ideally
  labelled by someone other than the system's authors.
- Synthetic tickets are cleaner than real ones. Treat results as a regression check and a comparison
  between prompts or models on identical data, not as a forecast of production accuracy. For production
  accuracy use Q07 once real tickets have been independently labelled.
- Labels come from the same team that built the system; a second labeller would reduce that bias.
- Results depend on the model, its version and the prompt at run time. Rerun to compare.

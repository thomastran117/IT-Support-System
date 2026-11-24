# Offline hybrid knowledge search experiment (SD-086)

## Results and decision

Keep hybrid retrieval in the offline experiment. It improved two paraphrase results and added
about 10 ms to both p50 and p95 for queries that used vectors. The eight original SD-085 inputs
had identical relevance scores in both paths. The gains on this small synthetic set and the
additional latency and resources support keeping keyword search as the application path.

The November 23, 2026 run used SHA `66116bd6a50c6398b20e9f73b167eaeca29d2ec9`, 510 synthetic
articles and 458 published projections. It ran on the same ARM64 Docker host as SD-085 with
8 CPUs and 7.55 GiB of Docker memory, using Docker Engine 29.9.2, Node.js 22.23.5, PostgreSQL 16.15,
OpenSearch 3.10.0, and Transformers.js 4.3.2. Each query ran 20 measured times per path.

| Query set                 | Path          | Samples | Precision@3 | MRR@3 | p50 (ms) | p95 (ms) |
| ------------------------- | ------------- | ------: | ----------: | ----: | -------: | -------: |
| All 16                    | Keyword       |     320 |       0.333 | 0.781 |    13.17 |    62.59 |
| All 16                    | Hybrid policy |     320 |       0.354 | 0.833 |    23.78 |    64.31 |
| Eight SD-085 inputs       | Keyword       |     160 |       0.417 | 1.000 |     8.45 |    14.83 |
| Eight SD-085 inputs       | Hybrid        |     160 |       0.417 | 1.000 |    17.64 |    26.64 |
| Eight paraphrases         | Keyword       |     160 |       0.250 | 0.563 |    32.72 |    78.85 |
| Eight paraphrases         | Hybrid policy |     160 |       0.292 | 0.667 |    43.45 |    66.99 |
| 14 vector-eligible inputs | Keyword       |     280 |       0.381 | 0.893 |    11.35 |    46.74 |
| 14 vector-eligible inputs | Hybrid        |     280 |       0.405 | 0.952 |    21.54 |    57.12 |

Hybrid moved the relevant printer article from rank 2 to rank 1 for `stuck pages are blocking
other jobs`. It found the password article at rank 3 for `cannot sign in after forgetting my
credentials`, where the keyword path missed it in the top three. The `second screen blinks when
plugged into the hub` and `wired connection goes down, should I replace the cable` queries each
matched 345 OpenSearch candidates, exceeding the lexical adapter’s 300-candidate budget. Both
paths used PostgreSQL for those queries and returned the same results, with the intended article
absent from the top three. Comparing the vector-eligible rows isolates the retrieval overhead
from the timing variation on those two fallback cases.

There were zero paid provider requests. Loading the model took 0.82 s. Encoding 458 articles took
1.13 s, including input preparation and vector validation. Building the vector index took 1.89 s
including encoding and refresh. Its primary store occupied 3.38 MiB after the run. The evaluator
process used 13.06 CPU seconds from model load through indexing, warm-up, and measurement, and
peaked at 546 MiB RSS. These figures exclude the underlying PostgreSQL and OpenSearch processes.

The run uses one host, warm sequential requests, repeated synthetic topics, and 16 hand-labelled
queries. Production cost and concurrent-load latency require a representative workload. The vector index
is a disposable snapshot. PostgreSQL gates results when articles change, and tearing down the
experiment removes the stored vectors.

## Scope and data handling

This experiment compares the existing published knowledge BM25 path with reciprocal rank fusion
over BM25 and exact cosine vector search. It runs through the explicit `hybrid-experiment`
Compose profile on a fresh synthetic database and search node. The API, worker, and browser
use the existing keyword paths. The Compose job is the entry point for the experiment.

The corpus is the knowledge portion of [SD-085](search-evaluation.md), including the same 500
background articles and withheld drafts. The experiment seeds article and category fixtures. The
encoder reads the first 1,000 characters of each currently published title and body in batches of 16. The run caps the corpus at 1,000 published articles and applies the existing knowledge query
length limit. Only built-in synthetic queries go through the local encoder. Both Docker networks
have `internal: true`, and the model files are mounted read-only. The experiment requests no
inference service credentials and sends no inputs to a remote provider.

The encoder verifies SHA-256 for every model and tokenizer file, then runs the quantized MiniLM
model using Transformers.js on CPU with remote loading disabled. It emits normalized 384-value
vectors. The dedicated `smartdesk-experiment-knowledge-semantic-v1` index stores article IDs,
category IDs, revisions and embeddings with a strict mapping. Its mapping metadata records the
model and artifact revision. A new model or vector shape would need a new index version. The
index is scored exactly for this small corpus with its own mapping and no shared live aliases.
[Model and ONNX files](https://huggingface.co/Xenova/all-MiniLM-L6-v2/tree/751bff37182d3f1213fa05d7196b954e230abad9)
· [Local inference settings](https://huggingface.co/docs/transformers.js/en/api/env)
· [OpenSearch exact k-NN scoring](https://docs.opensearch.org/latest/vector-search/vector-search-techniques/knn-score-script/)

Each branch supplies up to 15 candidates. PostgreSQL rechecks publication, category and revision
for both branches in one read before reciprocal rank fusion (`k = 20`). Ties prefer the lexical
rank and then the article ID. The experiment returns up to three IDs. Model or vector index
failure falls back to verified keyword results. An unavailable lexical index, quoted or Boolean
syntax, and empty input follow the existing lexical adapter’s rules. The tests cover vector
schema, draft exclusion, stale published revisions, category moves and keyword fallback without
loading the model package.

## Reproduce the comparison

Run from the repository root with a fresh disposable Compose project. The setup downloads only
public model files. The subsequent evaluation runs inside the isolated Docker networks.

```bash
set -eu
model_rev=751bff37182d3f1213fa05d7196b954e230abad9
model_dir=$(mktemp -d)
mkdir -p "$model_dir/onnx"
for file in config.json tokenizer.json tokenizer_config.json onnx/model_quantized.onnx; do
  curl -fsSL "https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/$model_rev/$file" \
    -o "$model_dir/$file"
done

project=smartdesk-hybrid-knowledge-evaluation
compose() { docker compose -p "$project" --profile ci --profile search --profile hybrid-experiment "$@"; }
trap 'compose down -v' EXIT
compose up --wait --wait-timeout 180 postgres-ci opensearch
compose exec -T postgres-ci createdb -U ci smartdesk_hybrid_knowledge_test
compose build hybrid-knowledge-experiment
compose run --rm --no-deps \
  -e SEARCH_BENCHMARK_REVISION="$(git rev-parse HEAD)" \
  -v "$model_dir:/models/Xenova/all-MiniLM-L6-v2:ro" \
  hybrid-knowledge-experiment sh -c 'npm run migrate >&2 && ./node_modules/.bin/tsx experiments/hybrid-knowledge/evaluate.ts' \
  > hybrid-results.json
```

The JSON contains the tested SHA and model revision, input labels, returned IDs, per-query and
pooled timings, model load time, embedding and index build time, index storage, and process CPU
and peak memory. The evaluator runs three warm-ups and 20 measured rounds by default. Use
`HYBRID_EVALUATION_ROUNDS` in the experiment container for a different sample count.

## Evaluation method

Both paths use the same fixed PostgreSQL corpus, OpenSearch node, filters, and
[labelled query set](../backend/experiments/hybrid-knowledge/queries.ts). The set keeps all eight
SD-085 knowledge inputs and adds eight paraphrases over the same articles. Labels were defined
before running the model. Both paths preserve the lexical adapter’s PostgreSQL fallback for
queries that exhaust its OpenSearch candidate budget. The report also measures the queries
that go through the vector branch as a group. Trials run sequentially and alternate engine order. The lexical timing
includes the search service’s PostgreSQL verification. Hybrid timing also includes query encoding,
vector retrieval and final candidate verification. These are service-level measurements that
exclude Fastify, browser and client-to-API network time. Precision@3 uses three as the denominator,
and MRR@3 uses the reciprocal rank of the first relevant result or zero for a miss.

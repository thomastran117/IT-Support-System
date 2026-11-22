#!/bin/sh
set -eu

npm --prefix packages/contracts run lint
npm --prefix packages/contracts run typecheck
npm --prefix packages/contracts test
npm --prefix packages/contracts run build

npm --prefix frontend run lint
npm --prefix frontend run typecheck
npm --prefix frontend run test:unit
npm --prefix frontend run build
npm --prefix frontend run check:bundle
npm --prefix frontend run test:e2e

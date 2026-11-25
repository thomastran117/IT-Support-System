#!/bin/sh
set -eu

npm --prefix packages/contracts run lint
npm --prefix packages/contracts run typecheck
npm --prefix packages/contracts test
npm --prefix packages/contracts run build

npm --prefix backend run generate
npm --prefix packages/db run lint
npm --prefix packages/db run typecheck
npm --prefix packages/db test
npm --prefix packages/db run build

npm --prefix backend run lint
npm --prefix backend run typecheck
npm --prefix backend run build
npm --prefix backend run test:unit

npm --prefix backend run migrate
# SD-054: the migrated database must match schema.prisma exactly (exit 2 on any drift).
npm --prefix backend run check:drift
npm --prefix backend run test:integration

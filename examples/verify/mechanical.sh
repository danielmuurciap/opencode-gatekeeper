#!/bin/sh
# Acceptance for a rename/migration: the typecheck. Free, already exists,
# and catches exactly what mechanical changes break.
npx tsc --noEmit

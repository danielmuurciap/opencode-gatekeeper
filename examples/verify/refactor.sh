#!/bin/sh
# Acceptance for a refactor: the suite that already exists.
# Run it BEFORE dispatching too — red-before means the baseline was broken.
npm test -- --run

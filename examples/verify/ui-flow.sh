#!/bin/sh
# Acceptance for UI work: a Playwright FLOW test, the hardest check to fake.
# "The summary shows the new amount" — not "the component exists".
npx playwright test tests/checkout-summary.spec.js --reporter=line

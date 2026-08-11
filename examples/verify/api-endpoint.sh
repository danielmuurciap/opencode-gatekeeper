#!/bin/sh
# Acceptance for an API change: hit the real endpoint, assert on the JSON.
# Flow-level: proves routing + handler + serialization together.
curl -sf http://localhost:3000/api/quota | jq -e '.remaining >= 0 and .limit == 100'

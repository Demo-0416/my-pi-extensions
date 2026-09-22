# Changelog

## 0.1.3

- Fix inflated TPS on gateways that do not stream reasoning deltas (e.g. `model_hub/es1_orange_o50`). `usage.output` includes reasoning tokens, but the TTFT-to-end window only covers visible-text generation when thinking never arrives as stream deltas; those records now fall back to the full request duration, matching the reconstructed-session rate (measured 408 tok/s → 65 tok/s end-to-end).

## 0.1.2

- Pair output tokens and generation time from the same eligible assistant records when calculating TPS. Tool output and nested tool usage cannot inflate the model's rate.
- Reconstruct assistant duration from the request-start and session-entry timestamps, including the final response. Historical timing remains an estimate; TTFT is only available from live capture.
- Exclude missing, invalid, or very short timing samples from TPS rather than guessing a rate. Token and cost totals remain available.
- Report tool time as the union of tool windows, avoiding duplicate wall-clock time for parallel tools. Historical per-tool windows are estimates, not exact execution timings.
- Share statistics between the terminal and browser and add deterministic regression coverage.
- Align package metadata and installation instructions with `@demo-0416/pi-trace` on npm.

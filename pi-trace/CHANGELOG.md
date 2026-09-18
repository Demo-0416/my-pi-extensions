# Changelog

## 0.1.2

- Pair output tokens and generation time from the same eligible assistant records when calculating TPS. Tool output and nested tool usage cannot inflate the model's rate.
- Reconstruct assistant duration from the request-start and session-entry timestamps, including the final response. Historical timing remains an estimate; TTFT is only available from live capture.
- Exclude missing, invalid, or very short timing samples from TPS rather than guessing a rate. Token and cost totals remain available.
- Report tool time as the union of tool windows, avoiding duplicate wall-clock time for parallel tools. Historical per-tool windows are estimates, not exact execution timings.
- Share statistics between the terminal and browser and add deterministic regression coverage.
- Align package metadata and installation instructions with `@demo-0416/pi-trace` on npm.

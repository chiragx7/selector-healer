# 2 · Capture a baseline

**Capture Baseline** opens your app and, for every selector in your tests, records a **fingerprint** of the element it matches - its tag, attributes, text, and position.

That baseline is what "correct" looks like. It's saved to `.selector-healer/fingerprints.json` and committed with your code, so the baseline travels with the repo.

Nothing leaves your machine - Selector Healer only ever talks to **your own app**.

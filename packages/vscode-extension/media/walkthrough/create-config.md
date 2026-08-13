# 1 · Create a config

Selector Healer needs to know **where your tests live** and **which URL to check them against**.

Run **Create Config** and it will auto-detect:

- your **framework** (Playwright, Cypress, WebdriverIO, or TestCafe),
- your **base URL**,
- your **test directory**,

and write a ready-to-use `selector-healer.config` at your workspace root.

> Prefer to write it by hand? A minimal config is just `testDir` + `baseUrl`.

**Requirement:** Playwright must be a dev dependency in your project - it drives the live DOM during verification.

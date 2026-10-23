# Browser sessions

Add `--browser` to `fission run`, or `"browser": true` in a task file.
Fission quotes and buys a Browserbase session alongside the machine, within
the same budget. Preparation and work receive `FISSION_BROWSER_URL`, a CDP
WebSocket address. Install your preferred CDP client in preparation.

For Python with Playwright:

```python
import os
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.connect_over_cdp(os.environ["FISSION_BROWSER_URL"])
    page = browser.contexts[0].new_page()
    page.goto("https://example.com")
    print(page.title())
    page.close()
```

The browser runs at Browserbase. Its `localhost` is separate from the rented
machine. Supply a reachable URL when testing an application on that machine.
Treat the connection URL as a credential; do not print it or include it in
artifacts. Fission's status and reports show session identity and cleanup,
without the connection URL. The private local task record retains it.

The quote covers the requested total task duration, including setup. The provider
controls session expiry; buying time does not guarantee a refund for early stop.
Fission closes the browser on success, failure or stop. Status and reports confirm
cleanup only after both the machine and browser are closed. An unresolved
creation is never replaced automatically. `status NAME --resume` observes the
same recorded session after uncertain cleanup.

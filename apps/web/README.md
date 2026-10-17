# RSS Orbinex web workspace

This is a static browser client for the RSS Orbinex API. It can be hosted as static files and does not require a paid API key.

## Current connected workflows

- Online sign-in, session revalidation, and logout.
- Tenant-scoped customer, supplier, and product lists, with create forms.
- Invoice list and draft invoice creation with customer/product selection, multiple lines, quantities, prices, discounts, and tax amounts.
- Purchase bill, expense, payment, chart-of-accounts, and financial report views; expense draft creation.
- Explicit browser-origin allowlist in the API using `WEB_ORIGINS`.

## Important limitations

The API/database must be separately deployed and configured before the client can sign in. Set the API URL on the sign-in page to the real HTTPS API origin. The current client does not yet provide all post/settlement controls, PDF rendering, payment allocations, offline durable outbox, or end-to-end acceptance coverage. The browser preview is not a claim of production readiness.

Session tokens are kept in `sessionStorage`; on reload, the client checks the API session online. If the API cannot validate the session, the client returns to sign-in. The API must allow the static site's origin in `WEB_ORIGINS`.

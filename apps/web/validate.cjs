const fs = require("node:fs");
const path = require("node:path");
const root = __dirname;
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.webmanifest"), "utf8"));
const required = [
  'id="loginForm"', 'id="content"', 'id="sideNav"',
  "/v1/auth/login", "/v1/auth/session", "/v1/auth/logout",
  "/v1/customers", "/v1/suppliers", "/v1/products",
  "/v1/invoices", "/v1/purchase-bills", "/v1/expenses",
  "/v1/payments", "/v1/reports/profit-and-loss",
  "/v1/reports/balance-sheet", "/v1/accounting/trial-balance"
];
const missing = required.filter((item) => !html.includes(item));
if (missing.length) {
  console.error("Orbinex web validation failed; missing:", missing.join(", "));
  process.exit(1);
}
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
if (!scripts.length) throw new Error("No application script found.");
for (const [, source] of scripts) new Function(source);
if (manifest.name !== "RSS Orbinex" || manifest.start_url !== "./") {
  throw new Error("Invalid Orbinex web manifest.");
}
console.log("Orbinex web validation passed: HTML routes, inline JavaScript syntax, and manifest.");

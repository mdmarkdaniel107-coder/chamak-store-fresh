# CHAMAK STORE — fresh Cloudflare D1 app

A clean rebuild of the shop bookkeeping app using Cloudflare Workers, D1, and static mobile-first frontend assets.

## Important accounting contract

- Monetary values are stored as integer paisa. UI input/output uses BDT/taka.
- Quantity is stored in milli-units (1000 = 1.000 unit) to support weights/fractions.
- Itemized sale reduces stock and estimates COGS using the product's weighted-average purchase cost.
- Total sale stores revenue/collection/due but does not change stock or claim a real gross profit.
- Purchase increases stock and weighted-average cost; paid amount reduces the selected cash/bank account; supplier due is recorded separately.
- Customer collection reduces customer due and increases the selected account; it is not counted as a new sale.
- Supplier payment reduces supplier due and the selected account; it is not counted as a new purchase.
- Stock verification compares physical quantity and system quantity. A discrepancy is not auto-adjusted by the initial version.
- Used products are deactivated rather than hard-deleted.

## Setup (keep your existing D1 database ID)

1. Create a new GitHub repository or a clean branch, then upload the contents of this folder while preserving the folder structure.
2. Edit `wrangler.toml`: replace `REPLACE_WITH_YOUR_D1_DATABASE_ID` with the real ID of the existing `chamak-store-db` database. Do not create a new database unless you intend to. Worker name is `chamak-store-fresh` so it will not overwrite the old Worker while you verify the new version.
3. In a terminal, run `npm install`.
4. Apply the migration to the intended D1 database:
   - Local only: `npm run db:local`
   - Remote D1: `npm run db:remote`
5. Deploy with `npm run deploy`. The Worker is password-locked until the two secrets below are set.
6. In Cloudflare Workers → `chamak-store-fresh` → Settings → Variables and Secrets, add both as **Secret**, not plain text variables:
   - `APP_PASSWORD`: the password you will use to log in.
   - `SESSION_SECRET`: a separate long random secret (at least 32 characters).
   Never commit either secret to GitHub. Alternatively, use `npx wrangler secret put APP_PASSWORD` and `npx wrangler secret put SESSION_SECRET` after the Worker has been created.

Before running the remote migration, confirm the database name and ID in Cloudflare. This fresh schema should be applied only to the intended empty/new D1 database. Do not point it at an old database containing tables/data you need to preserve.

For local testing, create a `.dev.vars` file containing `APP_PASSWORD=...` and `SESSION_SECRET=...`; never upload `.dev.vars` to GitHub.

## API surface

- `GET /api/health`
- `GET /api/dashboard`
- `GET, POST, PATCH, DELETE /api/products`
- `GET, POST /api/customers`
- `GET, POST /api/suppliers`
- `GET /api/accounts`
- `POST /api/transactions/purchase`
- `POST /api/transactions/sale`
- `POST /api/transactions/total-sale`
- `POST /api/transactions/customer-collection`
- `POST /api/transactions/supplier-payment`
- `POST /api/transactions/expense`
- `POST /api/transactions/other-income`
- `GET /api/transactions?limit=100`
- `GET, POST /api/stock-verification`
- `GET, POST /api/settings`
- `GET /api/backup`
- `GET /api/audit-log`

## Scope and limitations of this first full version

- This is a fresh baseline, not a claim of production verification. Run the acceptance checklist before recording real transactions.
- Password login is included with an HttpOnly, Secure, SameSite session cookie. There are no user roles or rate-limit rules yet; Cloudflare Access can add another protection layer. Do not reuse the shop password elsewhere.
- Remote D1 batch statements are used for groups of related writes, but reads before a batch can still race under simultaneous concurrent submissions. Test with one operator first; stronger concurrency/idempotency controls should be added before multi-user use.
- Opening customer/supplier balances are stored on their master records and included in current due validation.
- Backup downloads a JSON snapshot. Restore/import is intentionally not exposed in this baseline to avoid accidental overwrites.
- Product stock value is weighted-average cost, not last purchase price. This avoids stock valuation changing when sale margin/profit percentages change.

## Acceptance checklist

1. Health API reports `ok: true`.
2. Add a test product; add a purchase; confirm stock and cash balance.
3. Make an itemized sale; confirm stock falls, cash rises by paid amount, and due rises by unpaid amount.
4. Collect customer due; confirm it is not added to sales again.
5. Pay supplier; confirm it is not added to purchases again.
6. Verify physical stock; a mismatch must not silently change stock.
7. Download a backup JSON and retain it outside the repository.

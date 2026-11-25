# SpendWise

SpendWise is a personal finance tracker for recording transactions, planning budgets, tracking bills and goals, and reviewing spending patterns. It supports local SQLite use and hosted deployments backed by Turso.

## Features

- Password-protected accounts with scrypt password hashing and persistent, revocable sessions.
- Expenses, cash entries, income, categories, search, date and category filters, edit and delete.
- CSV import with column mapping, preview, validation, and duplicate warnings; CSV transaction export.
- Weekly and monthly budgets with usage indicators and threshold notifications.
- Bills with due dates and recurrence, plus scheduled recurring transactions.
- Savings goals and contribution history.
- Dashboard totals, category and monthly trends, rule-based spending insights, reports, and a chronological financial replay.
- Three saved themes, privacy mode, INR by default, notification preferences, keyboard command search, and responsive desktop and mobile layouts.
- Local SQLite or hosted Turso persistence, account data export and deletion, an installable phone PWA, and a static-only service worker.

## Architecture

SpendWise uses a Node.js 24 HTTP server and a standards-based browser frontend. Local use stores data in SQLite through Node's built-in `node:sqlite` driver. The Vercel API uses `@libsql/client` to connect to Turso, so financial records persist outside the temporary function filesystem.

The server uses prepared SQL statements and scopes financial queries to the authenticated user. Monetary values are stored as integer paise and formatted as rupees in the UI. Passwords are derived with scrypt; session secrets are random and only their SHA-256 hashes are persisted. Browser sessions use HttpOnly, SameSite=Strict cookies. Mutating browser requests check their origin. The application binds to localhost by default. Private API responses are marked `no-store`, transaction search text is sent in a request body, and the service worker bypasses API requests.

In local mode, financial records stay in the SQLite database on the machine running the server. In hosted mode, account records are sent to and stored by the configured Turso database; the Vercel function filesystem is not used for persistent financial data. The app does not send records to analytics. Passwords are scrypt-derived and session secrets are stored as hashes, but the app does not encrypt database contents itself. Protect local machines with a private OS account and full-disk encryption. For hosted use, configure Turso access credentials as Vercel environment variables and review Turso's access, retention, and backup settings. Account deletion removes the user's rows from the active database; it cannot erase exports or copies stored elsewhere or guarantee immediate physical erasure from provider backups.

## Requirements

- Node.js 24 or later (for the built-in `node:sqlite` module).
- Node.js 24.x. `npm install` installs the Turso client used by hosted deployments.
- A Turso database and its `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` values are required for a hosted deployment. Local mode does not need those values.

## Run

From the project directory:

```powershell
npm start
```

Open <http://127.0.0.1:4173>. Register an account to start. Set `PORT` to use another port and `SPENDWISE_DB_PATH` to choose a different SQLite file. The default local database is `data/spendwise.sqlite` and is created automatically. Keep the database file private; it contains personal financial records.

## Install on a phone

SpendWise is a Progressive Web App, so the same hosted site can be added to a phone without maintaining a separate mobile codebase. Open the HTTPS deployment on Android in Chrome and choose **Install app** or **Add to Home screen** from the browser menu. On iPhone, open it in Safari, choose **Share → Add to Home Screen**, enable **Open as Web App**, then tap **Add**. Sign in to the same SpendWise account to see its records. An internet connection is required to read and save financial data.

For automatic restarts during development:

```powershell
npm run dev
```

## Deploy to Vercel

Create a Turso database, then add `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` to the Vercel project's environment variables. Deploy the project from its GitHub repository. The Vercel API initializes the schema in Turso on startup; new hosted accounts begin with an empty database. Local SQLite data is not uploaded or migrated.

## Test and checks

```powershell
npm run build
npm test
npm run check
```

The build command validates the directly served static assets; this dependency-free app does not bundle files. Tests use temporary SQLite databases and do not touch personal app data.

## Main files

- `src/server/index.mjs` — HTTP server, API, authentication, validation, and calculations.
- `public/index.html` — application shell and metadata.
- `public/app.js` — browser UI and API client.
- `public/styles.css` — themes, layout, responsive styling, and motion.
- `test/app.test.mjs` — API, persistence, validation, and account isolation checks.

## Known limits

- No direct bank, UPI, or card-network connection is included. Transactions are entered by the user, imported from CSV, or generated by a recurring schedule when due data is next requested.
- Receipt OCR and server push notifications are not included. In-app notifications are generated from saved records.
- This local app does not include multi-factor authentication, email verification, or remote account recovery. Run it only on a trusted machine and keep the database private.
- The UI is dependency-free rather than React and the backend is Node.js rather than Spring Boot because those requested build tools are unavailable in the supplied environment.
- Automated verification covers core API workflows; final visual testing depends on a browser being available.

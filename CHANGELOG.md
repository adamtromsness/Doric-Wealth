# Changelog

All notable changes to Doric. The version is shown in the app's top bar.

How to update it:
- Every change that ships adds a line under **Unreleased**, in the same branch as the code.
- `scripts/release.sh patch|minor|major` turns Unreleased into a dated version, bumps
  the version everywhere, and commits and tags `vX.Y.Z`. `scripts/local-prod/deploy.sh`
  only deploys a tagged release.
- **patch**: bug fixes only. **minor**: new or changed behavior. **major**: breaking
  changes, e.g. a data migration that needs manual steps.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed
- **Restore drill:** a pasted `APP_SECRET_KEY` is trimmed of stray spaces, and when it doesn't match the server's key, the drill shows a short fingerprint and the length of each (never the key itself) so you can tell which copy is out of date.

## [1.9.0] - 2026-10-05

### Added
- **My Books → Members** has **Remove** (for owners and admins) and **Leave** buttons. Removing someone ends their access on their next action. The last owner can't be removed or leave.
- **Account deletion** for operators: `deleteAccount.js` (locally `scripts/local-prod/delete-account.sh`) deletes a person's account and the books only they belong to, and removes them from shared books. It shows what it will do first, and a shared book they solely own needs a new owner named.
- **Release checks:** every release now runs all tests (including as a restricted database role, like production) and a browser smoke test before it's tagged, and deploys refuse a release without them. Deploys also require a recent **restore drill** (`scripts/local-prod/restore-drill.sh`), which restores the newest off-machine backup into a scratch database and proves the `APP_SECRET_KEY` you keep elsewhere can read it. After deploying, a read-only browser check confirms the app loads.
- On start-up, the server now checks that `APP_SECRET_KEY` still matches the database's stored secrets and logs a clear error if not.

### Changed
- If you switch books in one tab, other open tabs follow to that book instead of saving into it unexpectedly. A change made in a tab that was still showing the old book is stopped; that tab then reloads onto the new book's dashboard with a note saying so. Anything unsaved there is cleared, and anything it was still doing (such as a delete waiting for its safety download) is stopped, so it can't end up in the wrong book. Switching books in the same tab reloads it too.
- **Privacy** page: it now describes the background work you can turn on (scheduled bank imports and automatic property values), explains what deleting an account removes and how long deleted data stays in backups, and states HTTPS and the backup schedule only when this server is set up that way.
- **Bank imports (SimpleFIN)** bring in transactions once they post. Pending ones are left until then, and the **Include pending transactions** option is gone for now. Before, a pending charge was imported as final, so its posted amount and date never arrived.
- **Invite links** now work once and expire after 7 days by default, and the invite list shows each link's use count and expiry date. Before, links worked any number of times until revoked.

### Fixed
- **Bank balances from SimpleFIN** are now dated to when your bank measured them, in your time zone, instead of when Doric synced. Before, transactions that posted between those two times could be left out of the account balance.
- **Reconciliations:** a completed reconciliation now also locks the principal portion of loan payments in it (their split lines), and the account's liability setting and opening balance, until it's reopened. Before, editing a payment's split could change a reconciled loan balance.
- **Reconciliations:** completing one now rechecks every cleared transaction: it must still be posted, by the statement end date, in that account, and not already reconciled in another completed reconciliation for the account, including one completed at the same moment.
- Requests cut off by the browser (for example, when you move to another page quickly) no longer log server errors.
- **Restoring a backup** (My Data → Snapshots) now reconnects everything to the restored records: transaction tags for vehicles, properties, tags and subscriptions, insurance policies, utility and subscription categories, asset maintenance linked to a transaction, AI analyses, and budget headings. Before, these could point at the wrong record or at nothing after a restore.
- **Restoring part of a backup** (some data sets only) no longer damages data outside it. The preview now lists the data sets it replaces and how many current records they hold, and a restore is refused, with the reason, when records outside it point at what it replaces (for example, transactions at accounts). Links from restored records to records the book still has are kept; a record whose required link can't be restored (for example, a transaction's vehicle tag when neither the backup nor the book has that vehicle) stops the restore instead of being left out, and links that will be dropped are listed in the preview. Other changes to the book wait while a restore runs, so nothing can slip in between its checks and the replace. Before, such a restore could detach transactions from their accounts or bank links from their accounts.
- **Utility bills:** linking an existing transaction as a bill's payment now counts only what that transaction actually paid, can't reuse the same payment across bills beyond its amount, and only accepts expenses.
- **Utility bills:** editing a bill's payment transaction (its merchant, notes, dates and so on) no longer undoes its bill payments. Before, a payment covering several bills could leave all but one unpaid. Changing its amount or utility category re-applies it, across several open bills when it covers more than one.
- **Utility bills:** marking a bill paid now records the payment as posted on the paid date, so the account balance reflects it. Before, the payment sat in Pending.

## [1.8.0] - 2026-10-05

### Added
- **Off-machine backup copies:** the server can copy every backup to an S3-compatible storage bucket (such as Oracle Cloud Object Storage) each hour, keeping the same 30 days of history, so a lost server doesn't mean lost data.
- **Privacy** page in plain language: what Doric stores, who can see it, and when data leaves Doric (AI features send data to Anthropic; bank links use SimpleFIN; property estimates use RentCast). It's linked from sign-in, sign-up and the user menu, and the AI settings page now says what AI features send.
- **Forgot password?** on the sign-in page. When email is set up, it sends a reset link that works once, for 60 minutes. Until then, it tells you to ask the person who runs Doric, who can create a one-time link for you. Resetting your password signs you out on every device.

## [1.7.0] - 2026-10-05

### Fixed
- **Mark Posted** now asks for the posted date, pre-filled with the purchase date (moved to Monday for weekend purchases). Before, it stamped today's date, which was wrong when catching up on transactions that cleared earlier (#9).

### Changed
- **Subscription quick-fill prices** are updated to current US prices (checked October 2026), including Spotify Family at $21.99. Renamed plans and services use their new names (e.g. HBO Max, Paramount+ Premium, Xbox Game Pass Essential/Premium, Adobe Creative Cloud Pro), and the picker notes when prices were last checked. Existing subscriptions aren't changed (#11).
- **Direct Deposit** is now a transaction channel, alongside In-store, Online, Phone, Mail and Check, and can be used in the Transactions filter (#10).
- **Transactions** shows both the **Transaction Date** and the **Posted Date** (posted list), sorted by transaction date, newest first. Click either date heading to sort by it; click again to reverse. Amounts no longer wrap onto two lines (#8).

## [1.6.1] - 2026-10-05

### Fixed
- Nightly backups are taken reliably. They're now checked every 15 minutes and taken whenever the last one is more than a day old, so a computer that sleeps or restarts no longer skips nights. Before, backups could stop until the next restart.
- The release notes now list the Dependants and money-field changes under v1.6.0, where they shipped.

## [1.6.0] - 2026-10-02

### Added
- **Integrations → RentCast:** add a RentCast API key for your books to estimate property values from comparable sales. The key is stored encrypted and shared by everyone in the books; only owners and admins can change it.
- **Automatic property values:** on a property's Value tab, turn on **Update Value Automatically** to record a RentCast estimate each month (or week). The tab shows when it last updated, or why it couldn't.

### Changed
- **Money fields** now show dollars the way you'd write them (`$127,000.00`) whenever you're not typing in them, across the app. On **My Profile**, Annual Income, Desired Monthly Income and Monthly Contribution are now money fields too (#7).
- **My Profile → Dependants** shows each dependant's age, and a date of birth can't be in the future or more than 120 years ago (#6).

## [1.5.0] - 2026-10-02

### Changed
- **Add Transaction** now puts the cursor in the Amount field, so you can start typing the amount right away (#5).
- Doric supports **US dollars only**. Accounts in other currencies are refused instead of being added up as if they were dollars, and foreign-currency bank accounts linked through SimpleFIN aren't synced (the link shows why).
- Reconciliations (not shown in the app yet) can only be completed when the cleared balance matches the statement. A completed reconciliation and the transactions in it are locked until it's reopened, and every completion and reopening is recorded.

### Fixed
- When an AI feature can't reach Anthropic, you now see why and what to do: the API key was rejected (check AI Settings), Anthropic is rate-limiting or temporarily unavailable (try again), or the request timed out. Before, these showed "Internal error" (#4).
- Account balances now include purchases that posted after a balance snapshot, even when they were made before it. Before, those purchases were left out of the balance.
- Scheduled backups now run and capture your data. Before, they never ran with production settings.
- Restoring a backup now works with production settings. Before, it failed.
- Scheduled SimpleFIN imports now find your linked accounts with production settings.
- Confirming the same suggested transfer twice at the same moment no longer creates two transfers.
- Backups and exports are taken from one consistent moment, so edits made while one is running can't produce a mismatched file.

### Security
- Personal Anthropic API keys are now encrypted in the database. Keys saved before this are encrypted automatically.
- Updated dependencies (including React Router 7) to clear known advisories.

## [1.4.0] - 2026-10-01

### Changed
- **Sign-up is now by invitation.** New people need an invite link to create an account. An invite from **My Books → New Invite Link** adds them straight to that book. Before, they also got an empty book of their own.
- The sign-in and sign-up pages explain how to get access when you don't have an invite.

## [1.3.0] - 2026-10-01

### Added
- **What's New** page: click the version number in the top bar to see the current version and the notes for every release.

## [1.2.1] - 2026-10-01

### Fixed
- Errors like "AI is not configured…", SimpleFIN or RentCast being unreachable, and VIN lookup failures now show their actual message instead of "Internal error" (#1).
- The Add Vehicle page no longer triggers a server error in the background, and invalid vehicle ids now return a clear "must be a positive integer id" error instead of a server error (#2).

## [1.2.0] - 2026-10-01

### Changed
- **Add Asset** on Other Assets now opens a full page, like Add Vehicle and Add Property, instead of a popup. It also lets you choose what the asset tracks (value, maintenance, insurance, documents) when you create it.
- **Add Liability** on Other Liabilities now opens a full page instead of a popup too, with every detail field (lender, payment terms, payoff date) and the tracking choices available up front.

## [1.1.0] - 2026-10-01

### Added
- `CHANGELOG.md` and tagged releases (`scripts/release.sh`). The version in the top bar now changes with each release, and production deploys require a tagged release.

### Changed
- Vehicle value **Estimate & Record** and **Estimate** buttons are disabled when no Anthropic API key is configured, with a link to AI Settings. Before, they failed with "Internal error".

### Fixed
- Subscription yearly cost is now calculated from the actual amount. A $139/year subscription showed $138.96 (#3).
- The subscriptions summary no longer adds up per-subscription rounding errors in its monthly and yearly totals.

## [1.0.0] - 2026-10-01

### Added
- First production release, running locally in production mode: the AWS container image, a restricted database role (row-level security enforced), and nightly backups.

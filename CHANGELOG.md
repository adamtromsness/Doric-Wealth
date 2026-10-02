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
- **Add Transaction** now puts the cursor in the Amount field, so you can start typing the amount right away (#5).
- Doric supports **US dollars only**. Accounts in other currencies are refused instead of being added up as if they were dollars, and foreign-currency bank accounts linked through SimpleFIN aren't synced (the link shows why).
- Reconciliations (not shown in the app yet) can only be completed when the cleared balance matches the statement. A completed reconciliation and the transactions in it are locked until it's reopened, and every completion and reopening is recorded.

### Fixed
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

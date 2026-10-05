import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { AuthShell } from '../components/AuthShell';

interface PrivacyConfig {
  contact_email: string | null;
  https: boolean;
  backup_keep_days: number | null;
  offsite_backups: boolean;
}

// Plain-language privacy notice for the pilot. Reachable signed in or out
// (linked from sign-in, sign-up, and the user menu).
export default function Privacy() {
  const { user } = useAuth();
  // What this server is set up to do (HTTPS, backups), so the page states only what's true.
  const [cfg, setCfg] = useState<PrivacyConfig | null>(null);
  useEffect(() => {
    api.get<PrivacyConfig>('/auth/privacy').then(setCfg).catch(() => {});
  }, []);
  const contact = cfg?.contact_email ?? null;
  const who = contact
    ? <a href={`mailto:${contact}`}>{contact}</a>
    : 'the person who invited you to Doric';
  const days = cfg?.backup_keep_days ?? null;

  const body = (
    <div className="privacy" style={{ fontSize: 14, lineHeight: 1.6 }}>
      <p style={{ marginTop: 0 }}>Doric is in a <strong>pilot</strong>: a small group of invited people using it before a wider release. This page explains, in plain language, what happens to your data.</p>

      <h3>What Doric stores</h3>
      <p>Your account (name, email and a securely hashed password) and whatever you add to your books: accounts, balances, transactions, budgets, receipts and documents, properties, vehicles, and your profile, including dependants. There are no ads, no analytics and no tracking, and your data is never sold.</p>
      <p>Doric works in the background only for features you turn on. <strong>Scheduled bank imports</strong> fetch new transactions and balances from SimpleFIN, and <strong>automatic property values</strong> fetch estimates from RentCast, on the schedule you set, even when you're not signed in. Turn either off at any time.</p>

      <h3>Who can see it</h3>
      <p>Only the people you invite into your books. Each set of books is kept separate by the database itself. As with any self-hosted app, the person running Doric's server can technically access its database and backups. They use that access only to keep Doric running, restore backups, or when you ask for help.</p>

      <h3>How it's protected</h3>
      <p>
        {cfg?.https ? 'Connections use HTTPS. ' : ''}Passwords are stored only as salted hashes. API keys you add (Anthropic, RentCast) and bank connection credentials (SimpleFIN) are encrypted.{' '}
        {!cfg ? null : days
          ? <>The server's database is backed up daily, and each backup is kept for {days} days{cfg?.offsite_backups ? ', with a copy stored off the server' : ''}.</>
          : <>Backups of the server are up to the person running Doric.</>}
      </p>

      <h3>When data leaves Doric</h3>
      <p>Only when you use a feature that needs another service, and only what that feature needs:</p>
      <ul>
        <li><strong>AI features</strong> (analysis, receipt and invoice reading, value estimates) send the data involved, such as figures, transactions or a receipt image, to <strong>Anthropic</strong>, using an API key you or the server provides. Don't use AI features with anything you'd rather not share.</li>
        <li><strong>Linking a bank</strong> uses <strong>SimpleFIN</strong> to fetch your accounts and transactions.</li>
        <li><strong>Property value estimates</strong> send the property's address to <strong>RentCast</strong>.</li>
        <li><strong>VIN look-up</strong> sends a vehicle's VIN to the US government's <strong>NHTSA</strong> decoding service.</li>
        <li>The app's fonts load from <strong>Google Fonts</strong>, so your browser contacts Google when Doric opens.</li>
      </ul>

      <h3>Your choices</h3>
      <p>You can change or delete your own data in the app at any time. To have your whole account and data deleted, or with any question about your data, contact {who}.</p>
      <p>Deleting an account deletes it and every book only you belong to, with everything in them. From books shared with others you're removed, and those books stay with the other members. Deleted data stays in the server's backups until they expire{days ? <>, up to {days} days later</> : ''}, and is then gone.</p>

      <h3>Pilot caveats</h3>
      <p>Doric is still being built. Features and this notice may change, and it's provided as-is during the pilot, without guarantees of availability. Keep your own records of anything important.</p>
    </div>
  );

  if (user) {
    return (
      <>
        <div className="page-head"><div><div className="eyebrow">Doric</div><h1 className="title">Privacy</h1></div></div>
        <div className="card" style={{ maxWidth: 760 }}>{body}</div>
      </>
    );
  }
  return (
    <AuthShell title="Privacy">
      {body}
      <p className="muted" style={{ fontSize: 13, marginTop: 16 }}><Link to="/login">Back to sign in</Link></p>
    </AuthShell>
  );
}

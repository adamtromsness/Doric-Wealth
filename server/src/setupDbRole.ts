// Create (or update) a NON-superuser application role and grant it CRUD on the
// public schema, so the running app can connect as it and Postgres row-level
// security is actually enforced (superusers bypass RLS). Run once as the
// privileged DB user, then point APP_DATABASE_URL at this role.
//
// Usage:
//   APP_DB_USER=finance_app APP_DB_PASSWORD='a-strong-password' npm run setup:db-role
// Then set, for the running app:
//   APP_DATABASE_URL=postgresql://finance_app:<password>@<host>:5432/<db>
import pg from 'pg';
import { config } from './config.js';

async function run() {
  const user = (process.env.APP_DB_USER ?? 'finance_app').trim();
  const password = process.env.APP_DB_PASSWORD ?? '';
  if (!/^[a-z_][a-z0-9_]*$/.test(user)) {
    console.error(`Invalid APP_DB_USER "${user}" — use lower-case letters, digits, underscore.`);
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('APP_DB_PASSWORD must be set (>= 8 characters).');
    process.exit(1);
  }
  const ident = '"' + user.replace(/"/g, '""') + '"';
  const lit = "'" + password.replace(/'/g, "''") + "'";

  const pool = new pg.Pool({ connectionString: config.databaseUrl });
  const db = (await pool.query('SELECT current_database() AS d')).rows[0].d as string;
  const dbIdent = '"' + db.replace(/"/g, '""') + '"';

  const exists = (await pool.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [user])).rows[0];
  if (exists) {
    await pool.query(`ALTER ROLE ${ident} WITH LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD ${lit}`);
    console.log(`Updated role ${user}.`);
  } else {
    await pool.query(`CREATE ROLE ${ident} WITH LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD ${lit}`);
    console.log(`Created role ${user}.`);
  }

  // Privileges on existing + future objects.
  await pool.query(`GRANT CONNECT ON DATABASE ${dbIdent} TO ${ident}`);
  await pool.query(`GRANT USAGE ON SCHEMA public TO ${ident}`);
  await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ident}`);
  await pool.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${ident}`);
  await pool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${ident}`);
  await pool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${ident}`);

  console.log(`Granted CRUD on public schema to ${user}. RLS will apply to it (non-superuser).`);
  console.log(`Set APP_DATABASE_URL to connect the app as ${user}.`);
  await pool.end();
}

run().catch((err) => {
  console.error('setup:db-role failed:', err);
  process.exit(1);
});

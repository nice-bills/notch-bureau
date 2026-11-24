// Test harness: a real Postgres (PGlite) that looks enough like a Supabase project for our migrations to run.
// What is faked (Supabase provides these on a real project): the roles anon / authenticated / service_role, the
// auth schema (users, identities, uid()), and a supabase_realtime publication. The migrations themselves are the
// real files from supabase/migrations, applied in order.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.join(here, '..', 'migrations');

const SHIM = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid());
create table auth.identities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id),
  provider text not null,
  provider_id text not null,
  identity_data jsonb not null default '{}'
);
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
$$;
grant usage on schema auth, public to anon, authenticated, service_role;
create publication supabase_realtime;
-- Supabase gives every role everything on new public tables by default; reproduce that so the revokes are tested.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
`;

// `PGlite` is passed in by the caller: the package is installed in enclave/, not next to this folder.
export async function newDb(PGlite) {
  const db = new PGlite();
  await db.exec(SHIM);
  for (const f of fs.readdirSync(MIGRATIONS_DIR).filter((n) => n.endsWith('.sql')).sort()) {
    await db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
  }
  return db;
}

// Run `fn` as a Supabase role (set role, like PostgREST does). `userId` + `claims` stand in for the request's JWT.
export async function asRole(db, role, fn, { userId, claims = {} } = {}) {
  await db.exec(`set role ${role}`);
  if (userId) await db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ sub: userId, role, ...claims })]);
  try {
    return await fn(db);
  } finally {
    await db.exec("reset role; select set_config('request.jwt.claims', '', false)");
  }
}

export async function createWeb3User(db, wallet) {
  const { rows } = await db.query('insert into auth.users default values returning id');
  const id = rows[0].id;
  await db.query("insert into auth.identities (user_id, provider, provider_id, identity_data) values ($1, 'web3', $2, $3)", [
    id,
    `web3:solana:${wallet}`,
    JSON.stringify({ address: wallet, chain: 'solana' }),
  ]);
  return id;
}

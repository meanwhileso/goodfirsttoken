-- Better Auth's tables, for signing in on the site: each person's user, their
-- sessions, their GitHub account and its token, and each sign-in still in
-- progress. Better Auth reads and writes them. docs/architecture.md describes
-- each table, and src/auth/auth.ts maps its fields to these columns.
--
-- The tables and columns are the ones the CLI of Better Auth 1.7.6 generates
-- for SQLite (`auth generate`), with snake_case names. Better Auth checks them
-- when it starts, so a column it expects can't go missing. It writes times as
-- ISO 8601 text and true or false as 1 or 0, so those columns are TEXT and
-- INTEGER here.
--
-- 0001's tables hold no GitHub token. The account table here does: each
-- person's token from their last sign-in, in account.access_token, which
-- Better Auth encrypts with AUTH_SECRET before it writes it.

-- One per person who has signed in on the site. Who they are is the GitHub
-- account in `account`. Better Auth needs an email for each user. We never ask
-- GitHub for one, so each is a placeholder under .invalid, a domain that never
-- resolves.
CREATE TABLE "user" (
  id TEXT NOT NULL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  email_verified INTEGER NOT NULL,
  image TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

-- A signed-in browser. Its cookie holds the token, signed.
CREATE TABLE session (
  id TEXT NOT NULL PRIMARY KEY,
  expires_at TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- Better Auth keeps no IP address here, since src/auth/auth.ts turns that
  -- off, so this stays empty.
  ip_address TEXT,
  user_agent TEXT,
  user_id TEXT NOT NULL REFERENCES "user" (id) ON DELETE CASCADE
) STRICT;

-- Signing out ends every session a person has.
CREATE INDEX session_by_user ON session (user_id);

-- A person's GitHub account: its numeric GitHub ID as text in account_id, and
-- the token from their last sign-in, encrypted. Sign-in asks for no refresh
-- or ID token, and there is no password.
CREATE TABLE account (
  id TEXT NOT NULL PRIMARY KEY,
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  access_token TEXT,
  refresh_token TEXT,
  id_token TEXT,
  access_token_expires_at TEXT,
  refresh_token_expires_at TEXT,
  scope TEXT,
  password TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

-- Each page view finds who is signed in from their user's GitHub account.
CREATE INDEX account_by_user ON account (user_id);
-- Sign-in finds the person by their GitHub account, and one GitHub account is
-- one person.
CREATE UNIQUE INDEX account_by_provider ON account (provider_id, account_id);

-- A sign-in in progress: the state sent to GitHub, with the PKCE verifier and
-- where to go after. A row lasts 10 minutes, and the cookie that ties it to
-- the browser 5, so a sign-in has 5 minutes to come back.
CREATE TABLE verification (
  id TEXT NOT NULL PRIMARY KEY,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

-- GitHub sends the person back with the state, which finds their sign-in.
CREATE INDEX verification_by_identifier ON verification (identifier);

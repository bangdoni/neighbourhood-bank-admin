-- Neighbourhood Bank Admin Bot — Cloudflare D1 schema (SQLite)
-- Run in Cloudflare dashboard → D1 console, or `wrangler d1 execute <db> --file=schema.sql`.
-- Timestamps and jsonb are TEXT (ISO strings / JSON).

create table if not exists config (
  key text primary key,
  value text not null default '',
  description text default '',
  updated_at text,
  updated_by text default ''
);

create table if not exists admins (
  admin_id text primary key,
  telegram_id text,
  name text not null,
  phone text,
  role text not null,
  status text not null default 'ACTIVE',
  created_at text,
  updated_at text,
  created_by text default 'SYSTEM'
);

create unique index if not exists admins_telegram_id_uniq
  on admins(telegram_id) where telegram_id is not null;

create unique index if not exists admins_phone_uniq
  on admins(phone) where phone is not null;

create table if not exists users (
  user_id text primary key,
  telegram_id text,
  telegram_username text,
  name text not null,
  phone text,
  address text,
  status text not null default 'ACTIVE',
  monthly_fee integer,
  created_at text,
  updated_at text
);

create table if not exists transactions (
  transaction_id text primary key,
  timestamp text,
  user_id text,
  type text not null,
  amount integer not null,
  period text,
  payment_method text,
  description text,
  balance_after integer,
  created_by text,
  status text not null default 'COMPLETED',
  reference text
);

create unique index if not exists transactions_reference_uniq
  on transactions(reference) where reference is not null;

create table if not exists audit (
  audit_id text primary key,
  timestamp text,
  admin_id text,
  telegram_id text,
  action text,
  target_type text,
  target_id text,
  details text,
  status text default 'SUCCESS'
);

create table if not exists bot_state (
  chat_id integer primary key,
  state text not null default '{}',
  updated_at text
);

create table if not exists processed_updates (
  update_id integer primary key,
  processed_at text
);

-- User bot uses its own dedup table so update_ids cannot collide with the admin bot.
create table if not exists processed_updates_user (
  update_id integer primary key,
  processed_at text
);

create table if not exists notifications (
  id integer primary key autoincrement,
  user_id text not null default '',
  period text not null,
  type text not null default 'MONTHLY_REMINDER',
  sent_at text,
  unique (user_id, period, type)
);

-- Atomic id counter; nextId() does INSERT ... ON CONFLICT ... RETURNING n.
create table if not exists counters (
  name text primary key,
  n integer not null default 0
);

-- Seed default config
insert or ignore into config (key, value, description) values
  ('monthly_fee', '50000', 'Default monthly contribution'),
  ('currency', 'IDR', ''),
  ('timezone', 'Asia/Jakarta', ''),
  ('payment_due_day', '10', ''),
  ('bank_name', '', ''),
  ('account_name', '', ''),
  ('account_number', '', ''),
  ('qr_url', '', 'Public QR image URL'),
  ('monthly_reminder_enabled', 'true', ''),
  ('payment_notification_enabled', 'true', ''),
  ('admin_daily_summary_enabled', 'true', '');

-- Seed initial SUPER_ADMIN. Change telegram_id to your numeric Telegram ID if different.
insert or ignore into admins (admin_id, telegram_id, name, role, status)
  values ('ADM-0001', '198058921', 'Administrator User', 'SUPER_ADMIN', 'ACTIVE');

-- Seed counters so the first generated ids are NB-0001, TX-000001, AUD-000001, ADM-0002
insert or ignore into counters (name, n) values
  ('users', 1), ('transactions', 1), ('audit', 1), ('admins', 1);

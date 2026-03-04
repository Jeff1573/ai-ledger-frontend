-- 创建迁移所需扩展（用于生成 UUID）。
create extension if not exists pgcrypto;

-- 应用用户表：单账号模式仍保留为通用用户表，便于后续扩展。
create table if not exists public.app_users (
  id uuid primary key,
  username text not null unique,
  password_hash text not null,
  password_version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- AI 配置表：按 user_id 存储 provider/base_url/token/provider_models。
create table if not exists public.ai_configs (
  user_id uuid primary key references public.app_users(id) on delete cascade,
  provider text not null check (provider in ('openai', 'anthropic')),
  base_url text not null,
  token text not null,
  provider_models jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 用户偏好表：当前用于类别预设同步。
create table if not exists public.user_preferences (
  user_id uuid primary key references public.app_users(id) on delete cascade,
  category_presets jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 账单表：按 (user_id, id) 唯一，支持多端同步。
create table if not exists public.ledger_entries (
  user_id uuid not null references public.app_users(id) on delete cascade,
  id text not null,
  amount numeric(12, 2) not null check (amount > 0),
  currency text not null default 'CNY',
  occurred_at timestamptz not null,
  location text,
  payment_method text,
  merchant text,
  category text not null default '其他',
  note text,
  transaction_type text not null check (transaction_type in ('expense', 'income')),
  source_image_name text,
  ai_provider text not null check (ai_provider in ('openai', 'anthropic')),
  ai_model text,
  ai_confidence numeric(4, 3),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create index if not exists idx_ledger_entries_user_occurred_at
  on public.ledger_entries(user_id, occurred_at desc);

create index if not exists idx_ledger_entries_user_updated_at
  on public.ledger_entries(user_id, updated_at desc);


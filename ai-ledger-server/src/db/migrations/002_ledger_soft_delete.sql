-- 账单软删除能力：新增删除标记与删除时间，支持跨端同步删除状态。
alter table public.ledger_entries
  add column if not exists is_deleted boolean not null default false;

alter table public.ledger_entries
  add column if not exists deleted_at timestamptz;

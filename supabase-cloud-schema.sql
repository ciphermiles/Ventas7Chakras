create table if not exists public.pos_state (
  business_id text primary key,
  state jsonb not null,
  updated_by text,
  updated_at timestamptz not null default now()
);

create table if not exists public.pos_backups (
  id text primary key,
  business_id text not null,
  backup_type text not null default 'manual',
  created_by text,
  filename text not null,
  state jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists pos_backups_business_created_idx
on public.pos_backups (business_id, created_at desc);

alter table public.pos_state enable row level security;
alter table public.pos_backups enable row level security;

drop policy if exists "pos_state_read_public_anon" on public.pos_state;
drop policy if exists "pos_state_insert_public_anon" on public.pos_state;
drop policy if exists "pos_state_update_public_anon" on public.pos_state;
drop policy if exists "pos_state_read_authenticated" on public.pos_state;
drop policy if exists "pos_state_insert_authenticated" on public.pos_state;
drop policy if exists "pos_state_update_authenticated" on public.pos_state;

create policy "pos_state_read_authenticated"
on public.pos_state
for select
to authenticated
using (true);

create policy "pos_state_insert_authenticated"
on public.pos_state
for insert
to authenticated
with check (true);

create policy "pos_state_update_authenticated"
on public.pos_state
for update
to authenticated
using (true)
with check (true);

drop policy if exists "pos_backups_read_authenticated" on public.pos_backups;
drop policy if exists "pos_backups_insert_authenticated" on public.pos_backups;

create policy "pos_backups_read_authenticated"
on public.pos_backups
for select
to authenticated
using (true);

create policy "pos_backups_insert_authenticated"
on public.pos_backups
for insert
to authenticated
with check (true);

do $$
begin
  begin
    alter publication supabase_realtime add table public.pos_state;
  exception when duplicate_object then null;
  end;
end $$;

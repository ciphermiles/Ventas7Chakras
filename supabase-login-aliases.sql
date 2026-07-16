-- Alias de acceso para 7 Chakras.
-- Permite iniciar sesión como "Nexo" manteniendo, por ejemplo,
-- el correo real master@ventas7chakras.local y su misma contraseña.
-- Ejecuta este archivo DESPUÉS de supabase-single-store-rls.sql.

create table if not exists public.pos_login_aliases (
  username text primary key,
  auth_email text not null unique,
  updated_at timestamptz not null default now()
);

alter table public.pos_login_aliases enable row level security;
revoke all on table public.pos_login_aliases from anon, authenticated;

insert into public.pos_login_aliases (username, auth_email)
values
  ('master', 'master@ventas7chakras.local'),
  ('admin', 'admin@ventas7chakras.local'),
  ('supervisor1', 'supervisor1@ventas7chakras.local'),
  ('supervisor2', 'supervisor2@ventas7chakras.local'),
  ('vendedor', 'vendedor@ventas7chakras.local')
on conflict (username) do update
set auth_email = excluded.auth_email, updated_at = now();

create or replace function public.resolve_pos_login(login_name text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select auth_email
  from public.pos_login_aliases
  where username = lower(trim(login_name))
  limit 1;
$$;

create or replace function public.set_pos_login_alias(
  previous_username text,
  new_username text,
  login_email text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  requester text := lower(coalesce(auth.jwt() ->> 'email', ''));
  clean_username text := lower(trim(coalesce(new_username, '')));
  clean_email text := lower(trim(coalesce(login_email, '')));
  existing_email text;
begin
  if auth.uid() is null then
    raise exception 'Se requiere iniciar sesión';
  end if;

  if requester not in ('master@ventas7chakras.local', 'admin@ventas7chakras.local')
     and requester <> clean_email then
    raise exception 'No tienes permiso para modificar este usuario';
  end if;

  if clean_username !~ '^[a-z0-9._-]{3,40}$' then
    raise exception 'El usuario debe tener entre 3 y 40 caracteres: letras, números, punto, guion o guion bajo';
  end if;

  select auth_email into existing_email
  from public.pos_login_aliases
  where username = clean_username;

  if existing_email is not null and existing_email <> clean_email then
    raise exception 'Ese usuario ya está en uso';
  end if;

  -- Cada correo conserva un único usuario de acceso; al cambiarlo se elimina el anterior.
  delete from public.pos_login_aliases
  where auth_email = clean_email;

  insert into public.pos_login_aliases (username, auth_email, updated_at)
  values (clean_username, clean_email, now())
  on conflict (username) do update
  set auth_email = excluded.auth_email, updated_at = now();
end;
$$;

revoke all on function public.resolve_pos_login(text) from public;
revoke all on function public.set_pos_login_alias(text, text, text) from public;
grant execute on function public.resolve_pos_login(text) to anon, authenticated;
grant execute on function public.set_pos_login_alias(text, text, text) to authenticated;

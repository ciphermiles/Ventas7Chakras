-- Seguridad para la única instalación: 7 Chakras / tienda-principal.
-- Ejecuta este archivo completo en Supabase SQL Editor después de generar un respaldo.
-- Las cuentas de Authentication deben usar exactamente los correos de esta lista.

alter table public.pos_state enable row level security;
alter table public.pos_backups enable row level security;

drop policy if exists "pos_state_read_authenticated" on public.pos_state;
drop policy if exists "pos_state_insert_authenticated" on public.pos_state;
drop policy if exists "pos_state_update_authenticated" on public.pos_state;
drop policy if exists "pos_state_read_7_chakras" on public.pos_state;
drop policy if exists "pos_state_insert_7_chakras" on public.pos_state;
drop policy if exists "pos_state_update_7_chakras" on public.pos_state;

drop policy if exists "pos_backups_read_authenticated" on public.pos_backups;
drop policy if exists "pos_backups_insert_authenticated" on public.pos_backups;
drop policy if exists "pos_backups_read_7_chakras" on public.pos_backups;
drop policy if exists "pos_backups_insert_7_chakras" on public.pos_backups;

create policy "pos_state_read_7_chakras"
on public.pos_state for select to authenticated
using (
  business_id = 'tienda-principal'
  and (select auth.jwt() ->> 'email') in (
    'master@ventas7chakras.local',
    'admin@ventas7chakras.local',
    'supervisor1@ventas7chakras.local',
    'supervisor2@ventas7chakras.local',
    'vendedor@ventas7chakras.local'
  )
);

create policy "pos_state_insert_7_chakras"
on public.pos_state for insert to authenticated
with check (
  business_id = 'tienda-principal'
  and (select auth.jwt() ->> 'email') in (
    'master@ventas7chakras.local',
    'admin@ventas7chakras.local',
    'supervisor1@ventas7chakras.local',
    'supervisor2@ventas7chakras.local',
    'vendedor@ventas7chakras.local'
  )
);

create policy "pos_state_update_7_chakras"
on public.pos_state for update to authenticated
using (
  business_id = 'tienda-principal'
  and (select auth.jwt() ->> 'email') in (
    'master@ventas7chakras.local',
    'admin@ventas7chakras.local',
    'supervisor1@ventas7chakras.local',
    'supervisor2@ventas7chakras.local',
    'vendedor@ventas7chakras.local'
  )
)
with check (
  business_id = 'tienda-principal'
  and (select auth.jwt() ->> 'email') in (
    'master@ventas7chakras.local',
    'admin@ventas7chakras.local',
    'supervisor1@ventas7chakras.local',
    'supervisor2@ventas7chakras.local',
    'vendedor@ventas7chakras.local'
  )
);

create policy "pos_backups_read_7_chakras"
on public.pos_backups for select to authenticated
using (
  business_id = 'tienda-principal'
  and (select auth.jwt() ->> 'email') in (
    'master@ventas7chakras.local',
    'admin@ventas7chakras.local',
    'supervisor1@ventas7chakras.local',
    'supervisor2@ventas7chakras.local',
    'vendedor@ventas7chakras.local'
  )
);

create policy "pos_backups_insert_7_chakras"
on public.pos_backups for insert to authenticated
with check (
  business_id = 'tienda-principal'
  and (select auth.jwt() ->> 'email') in (
    'master@ventas7chakras.local',
    'admin@ventas7chakras.local',
    'supervisor1@ventas7chakras.local',
    'supervisor2@ventas7chakras.local',
    'vendedor@ventas7chakras.local'
  )
);

-- Este esquema usa un único JSON de estado. Las políticas limitan el acceso a
-- las cuentas autorizadas de 7 Chakras; permisos por rol dentro de ese JSON
-- requieren una migración posterior a tablas separadas.

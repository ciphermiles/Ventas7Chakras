create table if not exists public.businesses (
  id text primary key,
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.user_profiles (
  id text primary key,
  business_id text not null references public.businesses(id),
  auth_user_id uuid unique,
  username text not null,
  auth_email text not null,
  full_name text not null,
  role text not null check (role in ('master', 'admin', 'supervisor', 'vendedor')),
  active boolean not null default true,
  access jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, username)
);

create table if not exists public.product_categories (
  id text primary key,
  business_id text not null references public.businesses(id),
  name text not null,
  active boolean not null default true,
  unique (business_id, name)
);

create table if not exists public.products (
  id text primary key,
  business_id text not null references public.businesses(id),
  category_id text references public.product_categories(id),
  name text not null,
  code text not null,
  alias_codes jsonb not null default '[]'::jsonb,
  stock_unit text not null default 'pieza',
  units numeric(14,3) not null default 0,
  cost numeric(14,2) not null default 0,
  price numeric(14,2) not null default 0,
  min_stock numeric(14,3) not null default 1,
  package_units numeric(14,3) not null default 0,
  package_price numeric(14,2) not null default 0,
  wholesale_min numeric(14,3) not null default 0,
  wholesale_price numeric(14,2) not null default 0,
  supplier text,
  location text,
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, code)
);

create table if not exists public.product_lots (
  id text primary key,
  product_id text not null references public.products(id),
  qty numeric(14,3) not null,
  cost numeric(14,2) not null,
  reference text,
  created_at timestamptz not null default now()
);

create table if not exists public.cash_registers (
  id text primary key,
  business_id text not null references public.businesses(id),
  user_id text not null references public.user_profiles(id),
  status text not null check (status in ('abierta', 'cerrada')),
  initial_amount numeric(14,2) not null default 0,
  final_amount numeric(14,2),
  ticket_amount numeric(14,2),
  expected_with_tickets numeric(14,2),
  closed_by_authorization text references public.user_profiles(id),
  opened_at timestamptz not null default now(),
  closed_at timestamptz
);

create table if not exists public.sales (
  id text primary key,
  business_id text not null references public.businesses(id),
  cash_id text not null references public.cash_registers(id),
  user_id text not null references public.user_profiles(id),
  ticket_folio text,
  total numeric(14,2) not null,
  paid numeric(14,2) not null,
  change numeric(14,2) not null,
  payment_method text not null,
  payments jsonb not null default '[]'::jsonb,
  status text not null default 'completada',
  created_at timestamptz not null default now()
);

create table if not exists public.sale_items (
  id text primary key,
  sale_id text not null references public.sales(id),
  product_id text not null references public.products(id),
  product_name text not null,
  qty numeric(14,3) not null,
  stock_qty numeric(14,3) not null,
  option_name text,
  cost_total numeric(14,2) not null,
  price numeric(14,2) not null,
  subtotal numeric(14,2) not null,
  profit numeric(14,2) not null,
  returned_qty numeric(14,3) not null default 0,
  returned_stock_qty numeric(14,3) not null default 0,
  cost_layers jsonb not null default '[]'::jsonb
);

create table if not exists public.expenses (
  id text primary key,
  business_id text not null references public.businesses(id),
  cash_id text not null references public.cash_registers(id),
  user_id text not null references public.user_profiles(id),
  description text not null,
  amount numeric(14,2) not null,
  authorized_by text references public.user_profiles(id),
  created_at timestamptz not null default now()
);

create table if not exists public.inventory_movements (
  id text primary key,
  business_id text not null references public.businesses(id),
  product_id text not null references public.products(id),
  user_id text not null references public.user_profiles(id),
  type text not null,
  before_qty numeric(14,3) not null,
  change_qty numeric(14,3) not null,
  after_qty numeric(14,3) not null,
  reference text,
  created_at timestamptz not null default now()
);

create table if not exists public.operation_logs (
  id text primary key,
  business_id text not null references public.businesses(id),
  user_id text references public.user_profiles(id),
  type text not null,
  table_name text not null,
  record_id text not null,
  description text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.admin_auth_settings (
  id smallint primary key check (id = 1),
  password_salt text,
  password_hash text,
  hash_iterations integer not null default 310000 check (hash_iterations between 10000 and 1000000),
  session_revision integer not null default 0 check (session_revision >= 0),
  updated_at timestamptz not null default now(),
  check ((password_salt is null) = (password_hash is null))
);

alter table public.admin_auth_settings enable row level security;

grant select, insert, update, delete on public.admin_auth_settings to service_role;

insert into public.admin_auth_settings (id)
values (1)
on conflict (id) do nothing;

notify pgrst, 'reload schema';

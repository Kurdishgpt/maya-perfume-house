-- Run this additive migration in the Maya Collection Supabase project.
-- SEO crawl data is private to the admin API; public sitemap endpoints read
-- eligible records through the server's service-role client.

create table if not exists public.seo_crawl_runs (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'running' check (status in ('running', 'complete', 'partial', 'failed')),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  scheduled boolean not null default false,
  site_origin text not null default 'https://mayacolllection.com',
  pages_discovered integer not null default 0,
  products_discovered integer not null default 0,
  raw_materials_discovered integer not null default 0,
  images_discovered integer not null default 0,
  urls_checked integer not null default 0,
  broken_links integer not null default 0,
  crawl_errors jsonb not null default '[]'::jsonb,
  queue_urls jsonb not null default '[]'::jsonb,
  seen_urls jsonb not null default '[]'::jsonb,
  settings_seeded boolean not null default false,
  limit_reached boolean not null default false,
  lease_token uuid,
  lease_until timestamptz,
  sitemap_generated_at timestamptz
);

create index if not exists seo_crawl_runs_started_idx
  on public.seo_crawl_runs (started_at desc);
create index if not exists seo_crawl_runs_status_idx
  on public.seo_crawl_runs (status);
create unique index if not exists seo_crawl_runs_single_active_idx
  on public.seo_crawl_runs (status) where status = 'running';

create table if not exists public.seo_discovery_records (
  url text primary key,
  canonical_url text not null,
  page_type text not null check (page_type in ('page', 'product', 'raw_material')),
  title text not null default '',
  html_title text not null default '',
  description text not null default '',
  image_urls text[] not null default '{}',
  price numeric,
  currency text,
  http_status integer,
  last_checked_at timestamptz,
  last_modified timestamptz,
  indexable boolean not null default false,
  sitemap_included boolean not null default false,
  issue_codes text[] not null default '{}',
  category text,
  google_index_status text not null default 'unknown'
    check (google_index_status in ('unknown', 'indexed', 'not_indexed')),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  is_removed boolean not null default false,
  internal_links text[] not null default '{}',
  broken_internal_links text[] not null default '{}',
  search_text text not null default ''
);

create index if not exists seo_discovery_type_idx
  on public.seo_discovery_records (page_type, is_removed);
create index if not exists seo_discovery_sitemap_idx
  on public.seo_discovery_records (sitemap_included, is_removed);
create index if not exists seo_discovery_last_checked_idx
  on public.seo_discovery_records (last_checked_at desc);
create index if not exists seo_discovery_issues_idx
  on public.seo_discovery_records using gin (issue_codes);

create table if not exists public.seo_crawl_settings (
  id smallint primary key check (id = 1),
  scheduled_enabled boolean not null default false,
  interval_hours integer not null default 24 check (interval_hours in (6, 12, 24)),
  updated_at timestamptz not null default now()
);

insert into public.seo_crawl_settings (id, scheduled_enabled, interval_hours)
values (1, false, 24)
on conflict (id) do nothing;

alter table public.seo_crawl_runs enable row level security;
alter table public.seo_discovery_records enable row level security;
alter table public.seo_crawl_settings enable row level security;

grant select, insert, update, delete on public.seo_crawl_runs to service_role;
grant select, insert, update, delete on public.seo_discovery_records to service_role;
grant select, insert, update, delete on public.seo_crawl_settings to service_role;

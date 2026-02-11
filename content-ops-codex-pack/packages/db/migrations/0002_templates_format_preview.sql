-- 0002_templates_format_preview.sql
-- Add format + preview fields for template packs

alter table if exists templates
  add column if not exists format text not null default 'A',
  add column if not exists status text not null default 'VALID',
  add column if not exists template_hash text,
  add column if not exists preview_assets jsonb,
  add column if not exists preview_error text,
  add column if not exists preview_generated_at timestamptz;

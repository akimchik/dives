-- Additive-only, all nullable: existing rows get null for every new column, no backfill needed.
alter table dives
  add column if not exists title text,
  add column if not exists waves text,
  add column if not exists water_temp_low numeric(4, 1),
  add column if not exists air_temp numeric(4, 1),
  add column if not exists weight_feedback text,
  add column if not exists start_pressure numeric(6, 2),
  add column if not exists end_pressure numeric(6, 2),
  add column if not exists cylinder_size numeric(5, 2),
  add column if not exists hood boolean,
  add column if not exists gloves boolean,
  add column if not exists boots boolean,
  add column if not exists water_type text,
  -- Free-form when the user picks "Other" in the UI rather than one of the fixed choices
  -- (Ocean/Lake/Quarry/River) -- one column, no separate "other" text column: the app never
  -- needs to distinguish "Other, note reads Cenote" from a value that just isn't one of the
  -- four fixed choices.
  add column if not exists body_of_water text;

create table if not exists public.workout_sets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  workout_id uuid not null,
  exercise text not null check (char_length(btrim(exercise)) between 1 and 60),
  weight numeric(7, 2) not null check (weight between 0 and 10000),
  reps integer not null check (reps between 1 and 1000),
  completed_at timestamptz not null default now()
);

create index if not exists workout_sets_user_workout_completed_idx
  on public.workout_sets (user_id, workout_id, completed_at);

alter table public.workout_sets enable row level security;

grant select, insert, delete on public.workout_sets to authenticated;

drop policy if exists "Users can read their own sets" on public.workout_sets;
create policy "Users can read their own sets"
  on public.workout_sets for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can insert their own sets" on public.workout_sets;
create policy "Users can insert their own sets"
  on public.workout_sets for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can delete their own sets" on public.workout_sets;
create policy "Users can delete their own sets"
  on public.workout_sets for delete to authenticated
  using ((select auth.uid()) = user_id);
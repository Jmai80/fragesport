-- =====================================================================
--  Frågesport – hela databasen
--  Supabase-projekt: wordle (oyhbdwtwtjtskfzwysrc)
--
--  Den här filen beskriver hur databasen ser ut i dag och kan användas
--  för att bygga upp allt från början i ett tomt Supabase-projekt.
--  Den körs inte automatiskt.
--
--  Utöver SQL:en behöver ett nytt projekt:
--    1. Authentication → Sign In / Providers → Allow anonymous sign-ins: på
--    2. Ett värdkonto: Authentication → Users → Add user (Auto Confirm)
--    3. Edge Functionen: supabase functions deploy media --no-verify-jwt
-- =====================================================================


-- ---------------------------------------------------------------------
--  Rumskoder: 5 tecken, utan lättförväxlade tecken som 0/O och 1/I
-- ---------------------------------------------------------------------

create or replace function quiz_ny_kod() returns text
language sql as $$
  select string_agg(
    substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', floor(random() * 32)::int + 1, 1), ''
  )
  from generate_series(1, 5);
$$;


-- ---------------------------------------------------------------------
--  Tabeller
-- ---------------------------------------------------------------------

-- Frågesporter
create table quiz_quizzes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users on delete cascade,
  titel text not null,
  beskrivning text,
  created_at timestamptz not null default now()
);

-- Frågor. media och alternativ är jsonb för att rymma bilder och ljud.
--   flerval: alternativ = ["A", "B", ...], ratt = alternativets plats (0, 1, ...)
--   nummer:  alternativ = [],              ratt = {"svar": 1974, "marginal": 10}
--   media:   {"typ": "ljud", "kalla": "itunes", "ref": "<låt-id>", "start": 0, ...}
--            {"typ": "bild", "kalla": "wikimedia", "ref": "<filnamn>", ...}
--            {"typ": "bild", "kalla": "url", "ref": "https://..."}
create table quiz_questions (
  id uuid primary key default gen_random_uuid(),
  quiz_id uuid not null references quiz_quizzes on delete cascade,
  position int not null,
  typ text not null default 'flerval' check (typ in ('flerval', 'nummer')),
  fraga text not null,
  media jsonb,
  alternativ jsonb not null default '[]',
  ratt jsonb not null,
  tid_sekunder int not null default 20 check (tid_sekunder between 5 and 120),
  -- deferrable så att två frågor kan byta plats i samma transaktion
  constraint quiz_questions_quiz_id_position_key
    unique (quiz_id, position) deferrable initially deferred
);

-- Rum: lobby → fraga → facit → fraga → ... → slut
create table quiz_rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique default quiz_ny_kod(),
  host_id uuid not null default auth.uid() references auth.users on delete cascade,
  status text not null default 'lobby',
  created_at timestamptz not null default now(),
  quiz_id uuid references quiz_quizzes on delete set null,
  fraga_nr int,
  fraga_start timestamptz,
  fraga_slut timestamptz,
  constraint quiz_rooms_status_check
    check (status in ('lobby', 'fraga', 'facit', 'slut'))
);

-- Spelare i ett rum (anonyma användare)
create table quiz_players (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references quiz_rooms on delete cascade,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  nickname text not null check (char_length(trim(nickname)) between 1 and 20),
  joined_at timestamptz not null default now(),
  unique (room_id, user_id)
);

create unique index quiz_players_unikt_namn on quiz_players (room_id, lower(nickname));

-- Svar. Skrivs bara av funktionen quiz_svara.
create table quiz_answers (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references quiz_rooms on delete cascade,
  player_id uuid not null references quiz_players on delete cascade,
  fraga_nr int not null,
  svar jsonb not null,
  ratt boolean not null,
  poang int not null,
  svarstid_ms int not null,
  created_at timestamptz not null default now(),
  unique (player_id, fraga_nr)
);

-- Visningsnamn för konton
create table quiz_profiles (
  user_id uuid primary key default auth.uid() references auth.users on delete cascade,
  namn text not null check (char_length(trim(namn)) between 1 and 40)
);


-- ---------------------------------------------------------------------
--  Row Level Security
-- ---------------------------------------------------------------------

alter table quiz_quizzes   enable row level security;
alter table quiz_questions enable row level security;
alter table quiz_rooms     enable row level security;
alter table quiz_players   enable row level security;
alter table quiz_answers   enable row level security;
alter table quiz_profiles  enable row level security;

-- Frågesporter: alla konton läser, bara ägaren ändrar
create policy "ägaren styr sina frågesporter" on quiz_quizzes
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid() and (auth.jwt() ->> 'is_anonymous')::boolean is not true);

create policy "konton läser alla frågesporter" on quiz_quizzes
  for select to authenticated
  using ((auth.jwt() ->> 'is_anonymous')::boolean is not true);

-- Frågor: samma princip. Anonyma spelare kan inte läsa facit.
create policy "ägaren styr sina frågor" on quiz_questions
  for all to authenticated
  using (exists (select 1 from quiz_quizzes q where q.id = quiz_id and q.owner_id = auth.uid()))
  with check (exists (select 1 from quiz_quizzes q where q.id = quiz_id and q.owner_id = auth.uid()));

create policy "konton läser alla frågor" on quiz_questions
  for select to authenticated
  using ((auth.jwt() ->> 'is_anonymous')::boolean is not true);

-- Rum
create policy "läs rum" on quiz_rooms for select to authenticated
  using (true);

create policy "skapa rum" on quiz_rooms for insert to authenticated
  with check (
    host_id = auth.uid()
    and (auth.jwt() ->> 'is_anonymous')::boolean is not true
  );

create policy "värden ändrar rum" on quiz_rooms for update to authenticated
  using (host_id = auth.uid())
  with check (host_id = auth.uid());

create policy "värden raderar rum" on quiz_rooms for delete to authenticated
  using (host_id = auth.uid());

-- Spelare
create policy "läs spelare" on quiz_players for select to authenticated
  using (true);

create policy "gå med" on quiz_players for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from quiz_rooms r
      where r.id = room_id and r.status = 'lobby'
    )
  );

create policy "lämna eller sparka" on quiz_players for delete to authenticated
  using (
    user_id = auth.uid()
    or exists (
      select 1 from quiz_rooms r
      where r.id = room_id and r.host_id = auth.uid()
    )
  );

-- Svar: bara värden läser
create policy "värden läser svar" on quiz_answers for select to authenticated
  using (exists (select 1 from quiz_rooms r where r.id = room_id and r.host_id = auth.uid()));

-- Profiler
create policy "konton läser profiler" on quiz_profiles
  for select to authenticated
  using ((auth.jwt() ->> 'is_anonymous')::boolean is not true);

create policy "skapa egen profil" on quiz_profiles
  for insert to authenticated
  with check (user_id = auth.uid() and (auth.jwt() ->> 'is_anonymous')::boolean is not true);

create policy "ändra egen profil" on quiz_profiles
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());


-- ---------------------------------------------------------------------
--  Realtid
-- ---------------------------------------------------------------------

alter publication supabase_realtime add table quiz_rooms, quiz_players, quiz_answers;


-- ---------------------------------------------------------------------
--  Värdens funktioner (körs med värdens behörighet, RLS gäller)
-- ---------------------------------------------------------------------

create or replace function quiz_nasta(p_rum uuid)
returns void language plpgsql set search_path = public as $$
declare
  r quiz_rooms;
  q quiz_questions;
begin
  select * into r from quiz_rooms where id = p_rum and host_id = auth.uid();
  if not found or r.quiz_id is null then
    raise exception 'Rummet finns inte';
  end if;

  select * into q from quiz_questions
  where quiz_id = r.quiz_id and position > coalesce(r.fraga_nr, 0)
  order by position
  limit 1;

  if not found then
    update quiz_rooms set status = 'slut', fraga_start = null, fraga_slut = null
    where id = p_rum;
  else
    update quiz_rooms set
      status = 'fraga',
      fraga_nr = q.position,
      fraga_start = now(),
      fraga_slut = now() + make_interval(secs => q.tid_sekunder)
    where id = p_rum;
  end if;
end $$;

create or replace function quiz_starta(p_rum uuid, p_quiz uuid)
returns void language plpgsql set search_path = public as $$
begin
  if not exists (select 1 from quiz_quizzes where id = p_quiz) then
    raise exception 'Frågesporten finns inte';
  end if;

  update quiz_rooms set quiz_id = p_quiz, fraga_nr = 0
  where id = p_rum and host_id = auth.uid() and status = 'lobby';
  if not found then
    raise exception 'Rummet går inte att starta';
  end if;

  perform quiz_nasta(p_rum);
end $$;

create or replace function quiz_facit(p_rum uuid)
returns void language sql set search_path = public as $$
  update quiz_rooms set status = 'facit'
  where id = p_rum and host_id = auth.uid() and status = 'fraga';
$$;

-- Avbryt spelet eller spela igen: spelarna är kvar, svar och poäng nollställs.
-- security definer eftersom värden inte har någon raderingspolicy på svaren.
create or replace function quiz_till_lobbyn(p_rum uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from quiz_rooms where id = p_rum and host_id = auth.uid()) then
    raise exception 'Rummet finns inte';
  end if;

  delete from quiz_answers where room_id = p_rum;

  update quiz_rooms set
    status = 'lobby',
    quiz_id = null,
    fraga_nr = null,
    fraga_start = null,
    fraga_slut = null
  where id = p_rum;
end $$;


-- ---------------------------------------------------------------------
--  Funktioner för alla i rummet (security definer, gör egna kontroller)
-- ---------------------------------------------------------------------

-- Aktuell fråga. Facit skickas bara med när rummet är i läget facit.
create or replace function quiz_aktuell_fraga(p_rum uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r quiz_rooms;
  q quiz_questions;
begin
  select * into r from quiz_rooms where id = p_rum;
  if not found then return null; end if;

  if r.host_id is distinct from auth.uid() and not exists (
    select 1 from quiz_players where room_id = p_rum and user_id = auth.uid()
  ) then
    raise exception 'Du är inte med i rummet';
  end if;

  if r.status not in ('fraga', 'facit') then return null; end if;

  select * into q from quiz_questions
  where quiz_id = r.quiz_id and position = r.fraga_nr;

  return jsonb_build_object(
    'nr', (select count(*) from quiz_questions where quiz_id = r.quiz_id and position <= r.fraga_nr),
    'antal', (select count(*) from quiz_questions where quiz_id = r.quiz_id),
    'typ', q.typ,
    'fraga', q.fraga,
    'media', q.media,
    'alternativ', q.alternativ,
    'tid', q.tid_sekunder,
    'kvar_ms', greatest(0, extract(epoch from (r.fraga_slut - now())) * 1000)::int,
    'ratt', case when r.status = 'facit' then q.ratt end
  );
end $$;

-- Svara. Rätt svar och poäng räknas här, med databasens klocka.
--   flerval: 1000 poäng direkt, sjunker till 500 vid tidens slut
--   nummer:  1000 poäng vid exakt svar, sjunker till 0 vid marginalen
create or replace function quiz_svara(p_rum uuid, p_svar jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  r quiz_rooms;
  q quiz_questions;
  spelar_id uuid;
  tid_ms int;
  ar_ratt boolean;
  poang int;
  avstand numeric;
begin
  select * into r from quiz_rooms where id = p_rum;
  if not found or r.status <> 'fraga' then
    raise exception 'Frågan är stängd';
  end if;
  if now() > r.fraga_slut + interval '1 second' then
    raise exception 'Tiden är ute';
  end if;

  select id into spelar_id from quiz_players
  where room_id = p_rum and user_id = auth.uid();
  if spelar_id is null then
    raise exception 'Du är inte med i rummet';
  end if;

  select * into q from quiz_questions
  where quiz_id = r.quiz_id and position = r.fraga_nr;

  tid_ms := least(extract(epoch from (now() - r.fraga_start)) * 1000, q.tid_sekunder * 1000)::int;

  if q.typ = 'nummer' then
    if jsonb_typeof(p_svar) <> 'number' then
      raise exception 'Svaret måste vara ett tal';
    end if;
    avstand := abs((p_svar #>> '{}')::numeric - (q.ratt ->> 'svar')::numeric);
    ar_ratt := avstand = 0;
    poang := greatest(0, round(1000 * (1 - avstand / (q.ratt ->> 'marginal')::numeric)))::int;
  else
    ar_ratt := p_svar = q.ratt;
    poang := case
      when ar_ratt then round(1000 * (1 - tid_ms / (q.tid_sekunder * 2000.0)))::int
      else 0
    end;
  end if;

  insert into quiz_answers (room_id, player_id, fraga_nr, svar, ratt, poang, svarstid_ms)
  values (p_rum, spelar_id, r.fraga_nr, p_svar, ar_ratt, poang, tid_ms)
  on conflict (player_id, fraga_nr) do nothing;
end $$;

-- Topplista och den egna placeringen. Bara i lägena facit och slut.
create or replace function quiz_resultat(p_rum uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r quiz_rooms;
begin
  select * into r from quiz_rooms where id = p_rum;
  if not found or r.status not in ('facit', 'slut') then return null; end if;

  if r.host_id is distinct from auth.uid() and not exists (
    select 1 from quiz_players where room_id = p_rum and user_id = auth.uid()
  ) then
    raise exception 'Du är inte med i rummet';
  end if;

  return (
    with summor as (
      select
        p.id, p.nickname, p.user_id,
        coalesce(sum(a.poang), 0)::int as poang,
        (select a2.poang from quiz_answers a2
         where a2.player_id = p.id and a2.fraga_nr = r.fraga_nr) as senaste
      from quiz_players p
      left join quiz_answers a on a.player_id = p.id
      where p.room_id = p_rum
      group by p.id
    ),
    rankade as (
      select *, rank() over (order by poang desc) as placering from summor
    )
    select jsonb_build_object(
      'topplista', coalesce(
        (select jsonb_agg(
           jsonb_build_object('namn', nickname, 'poang', poang, 'placering', placering)
           order by placering, nickname)
         from rankade),
        '[]'::jsonb),
      'jag',
        (select jsonb_build_object('poang', poang, 'placering', placering, 'senaste', senaste)
         from rankade where user_id = auth.uid())
    )
  );
end $$;


-- ---------------------------------------------------------------------
--  Redigerarens funktioner (körs med användarens behörighet, RLS gäller)
-- ---------------------------------------------------------------------

-- Flytta en fråga ett steg upp (-1) eller ned (1)
create or replace function quiz_flytta_fraga(p_fraga uuid, p_steg int)
returns void language plpgsql set search_path = public as $$
declare
  a quiz_questions;
  b quiz_questions;
begin
  select * into a from quiz_questions where id = p_fraga;
  if not found then raise exception 'Frågan finns inte'; end if;

  if p_steg < 0 then
    select * into b from quiz_questions
    where quiz_id = a.quiz_id and position < a.position
    order by position desc limit 1;
  else
    select * into b from quiz_questions
    where quiz_id = a.quiz_id and position > a.position
    order by position limit 1;
  end if;
  if not found then return; end if;

  update quiz_questions set position = b.position where id = a.id;
  update quiz_questions set position = a.position where id = b.id;
end $$;

-- Kopiera en frågesport, egen eller någon annans, till sina egna
create or replace function quiz_kopiera(p_quiz uuid)
returns uuid language plpgsql set search_path = public as $$
declare
  ny uuid;
begin
  insert into quiz_quizzes (titel, beskrivning)
  select titel || ' (kopia)', beskrivning from quiz_quizzes where id = p_quiz
  returning id into ny;
  if ny is null then raise exception 'Frågesporten finns inte'; end if;

  insert into quiz_questions (quiz_id, position, typ, fraga, media, alternativ, ratt, tid_sekunder)
  select ny, position, typ, fraga, media, alternativ, ratt, tid_sekunder
  from quiz_questions where quiz_id = p_quiz;

  return ny;
end $$;


-- ---------------------------------------------------------------------
--  Nattlig städning
-- ---------------------------------------------------------------------

create extension if not exists pg_cron with schema pg_catalog;

create or replace function quiz_stada()
returns jsonb language plpgsql set search_path = public as $$
declare
  antal_rum int;
  antal_anvandare int;
begin
  -- Rum utan aktivitet på ett dygn. Spelare och svar följer med automatiskt.
  delete from quiz_rooms
  where greatest(created_at, coalesce(fraga_start, created_at)) < now() - interval '1 day';
  get diagnostics antal_rum = row_count;

  -- Anonyma användare som inte längre hör till något rum
  delete from auth.users u
  where u.is_anonymous
    and u.created_at < now() - interval '1 day'
    and not exists (select 1 from quiz_players p where p.user_id = u.id);
  get diagnostics antal_anvandare = row_count;

  return jsonb_build_object('rum', antal_rum, 'anonyma_anvandare', antal_anvandare);
end $$;

revoke execute on function quiz_stada() from public, anon, authenticated;

select cron.schedule('quiz-stadning', '0 3 * * *', $$select quiz_stada()$$);
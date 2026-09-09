-- Contributor account lifecycle and sequential email outbox.
-- Depends on 202608290001_contributor_account_contract.sql.
--
-- Safe rollout rule: lifecycle_enabled starts false.  Applying this migration
-- alone does not restrict existing users and cannot send email.  A later,
-- coordinated cutover must set effective document versions and enable it.

create table if not exists public.account_lifecycle_config (
    singleton_id smallint primary key default 1 check (singleton_id = 1),
    lifecycle_enabled boolean not null default false,
    current_terms_version text,
    current_privacy_version text,
    reaccept_days integer not null default 365 check (reaccept_days between 365 and 730),
    inactivity_restrict_months integer not null default 24 check (inactivity_restrict_months >= 24),
    inactivity_delete_months integer not null default 36 check (inactivity_delete_months >= 36),
    dispatcher_daily_limit integer not null default 20 check (dispatcher_daily_limit between 1 and 500),
    dispatcher_pause_seconds numeric(8,3) not null default 5 check (dispatcher_pause_seconds between 0 and 3600),
    dispatcher_max_attempts integer not null default 5 check (dispatcher_max_attempts between 1 and 20),
    dispatcher_backoff_seconds integer not null default 300 check (dispatcher_backoff_seconds between 1 and 86400),
    pending_upload_ttl_hours integer not null default 24 check (pending_upload_ttl_hours between 1 and 168),
    pending_upload_cleanup_limit integer not null default 50 check (pending_upload_cleanup_limit between 1 and 500),
    updated_at timestamptz not null default now(),
    constraint account_lifecycle_versions_when_enabled check (
        not lifecycle_enabled or (
            length(current_terms_version) between 1 and 64
            and length(current_privacy_version) between 1 and 64
        )
    ),
    constraint account_lifecycle_inactivity_order check (
        inactivity_delete_months > inactivity_restrict_months
    )
);

insert into public.account_lifecycle_config (singleton_id)
values (1)
on conflict (singleton_id) do nothing;

alter table public.user_profiles
    add column if not exists inactivity_restricted_at timestamptz,
    add column if not exists inactivity_delete_after timestamptz,
    add column if not exists legal_notice_privacy_version text;

-- A client first reserves metadata, then uploads to Storage and finalizes the
-- track.  Claim abandoned reservations before deleting their exact object so
-- an interrupted cleanup can safely resume without touching ready tracks.
alter table public.user_gpx_tracks
    add column if not exists pending_cleanup_token uuid,
    add column if not exists pending_cleanup_claimed_at timestamptz;

alter table public.user_gpx_tracks
    drop constraint if exists user_gpx_tracks_status_check,
    add constraint user_gpx_tracks_status_check
        check (status in ('pending_upload', 'cleanup_pending', 'ready'));

alter table public.user_gpx_tracks
    drop constraint if exists user_gpx_tracks_ready_state,
    add constraint user_gpx_tracks_ready_state check (
        (status in ('pending_upload', 'cleanup_pending') and ready_at is null)
        or (status = 'ready' and ready_at is not null)
    ),
    drop constraint if exists user_gpx_tracks_cleanup_claim_consistent,
    add constraint user_gpx_tracks_cleanup_claim_consistent check (
        (status = 'cleanup_pending' and pending_cleanup_token is not null and pending_cleanup_claimed_at is not null)
        or (status <> 'cleanup_pending' and pending_cleanup_token is null and pending_cleanup_claimed_at is null)
    );

create index if not exists user_gpx_tracks_pending_cleanup_idx
    on public.user_gpx_tracks (status, created_at)
    where status in ('pending_upload', 'cleanup_pending');

do $$
begin
    if not exists (
        select 1 from pg_constraint
         where conrelid = 'public.user_profiles'::regclass
           and conname = 'user_profiles_legal_notice_privacy_consistent'
    ) then
        alter table public.user_profiles
            add constraint user_profiles_legal_notice_privacy_consistent check (
                (legal_notice_first_seen_at is null and legal_notice_privacy_version is null)
                or (legal_notice_first_seen_at is not null and legal_notice_privacy_version is not null)
            );
    end if;
end
$$;

create table if not exists public.user_legal_events (
    id bigint generated always as identity primary key,
    user_id uuid not null references public.user_profiles(user_id) on delete cascade,
    event_type text not null check (event_type in ('notice_seen', 'accepted', 'refused')),
    terms_version text not null check (length(terms_version) between 1 and 64),
    privacy_version text not null check (length(privacy_version) between 1 and 64),
    source text not null check (source in ('mobile', 'web')),
    occurred_at timestamptz not null default now(),
    unique (user_id, terms_version, privacy_version, event_type)
);

create index if not exists user_legal_events_user_time_idx
    on public.user_legal_events (user_id, occurred_at desc);

create table if not exists public.account_email_outbox (
    id bigint generated always as identity primary key,
    user_id uuid not null references auth.users(id) on delete cascade,
    event_type text not null check (event_type in (
        'terms_started', 'terms_six_months', 'terms_30_days', 'terms_7_days', 'terms_expired',
        'inactive_started', 'inactive_six_months', 'inactive_30_days', 'inactive_7_days', 'inactive_expired'
    )),
    dedupe_key text not null unique check (length(dedupe_key) between 1 and 240),
    payload jsonb not null default '{}'::jsonb,
    status text not null default 'pending' check (status in ('pending', 'sending', 'retry', 'sent', 'dead', 'cancelled')),
    available_at timestamptz not null default now(),
    attempt_count integer not null default 0 check (attempt_count >= 0),
    claim_token uuid,
    claimed_at timestamptz,
    sent_at timestamptz,
    last_error_code text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint account_email_outbox_claim_consistent check (
        (status = 'sending' and claim_token is not null and claimed_at is not null)
        or (status <> 'sending' and claim_token is null and claimed_at is null)
    )
);

create index if not exists account_email_outbox_dispatch_idx
    on public.account_email_outbox (status, available_at, id);

create table if not exists public.account_lifecycle_job_runs (
    run_date date primary key,
    owner_token uuid,
    lease_until timestamptz,
    status text not null default 'available' check (status in ('available', 'running', 'completed')),
    attempted_count integer not null default 0 check (attempted_count >= 0),
    sent_count integer not null default 0 check (sent_count >= 0),
    started_at timestamptz,
    completed_at timestamptz,
    updated_at timestamptz not null default now(),
    constraint account_lifecycle_job_lock_consistent check (
        (status = 'running' and owner_token is not null and lease_until is not null)
        or (status <> 'running' and owner_token is null and lease_until is null)
    )
);

create or replace function public.has_current_contributor_access(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select case
        when not cfg.lifecycle_enabled then true
        else exists (
            select 1
              from public.user_profiles profile
             where profile.user_id = p_user_id
               and profile.account_state = 'active'
               and profile.terms_version = cfg.current_terms_version
               and profile.privacy_version = cfg.current_privacy_version
               and profile.privacy_acknowledged_at is not null
        )
    end
      from public.account_lifecycle_config cfg
     where cfg.singleton_id = 1;
$$;

create or replace function public.require_current_contributor_access()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
    if auth.uid() is null then
        raise exception 'authentication required';
    end if;
    if not public.has_current_contributor_access(auth.uid()) then
        raise exception 'account access is restricted';
    end if;
end;
$$;

-- Preserve legacy signup while disabled; after cutover require the exact
-- server versions and stop treating the old research-consent flag as authority.
create or replace function public.handle_funghitracker_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    archive_cfg public.gpx_archive_config%rowtype;
    lifecycle_cfg public.account_lifecycle_config%rowtype;
    normalized_username text;
    accepted_at timestamptz := now();
    acceptance_source text;
begin
    select * into strict archive_cfg from public.gpx_archive_config where singleton_id = 1;
    select * into strict lifecycle_cfg from public.account_lifecycle_config where singleton_id = 1;
    normalized_username := lower(trim(coalesce(new.raw_user_meta_data ->> 'username', '')));
    if normalized_username !~ '^[a-z0-9_]{3,24}$' then
        raise exception 'username must match ^[a-z0-9_]{3,24}$';
    end if;

    if not lifecycle_cfg.lifecycle_enabled then
        if coalesce(new.raw_user_meta_data ->> 'terms_accepted', 'false') <> 'true'
           or coalesce(new.raw_user_meta_data ->> 'privacy_accepted', 'false') <> 'true'
           or coalesce(new.raw_user_meta_data ->> 'raw_gpx_research_consent', 'false') <> 'true' then
            raise exception 'legacy signup contract is incomplete';
        end if;
        insert into public.user_profiles (
            user_id, username, terms_accepted_at, terms_version,
            privacy_accepted_at, privacy_version,
            raw_gpx_research_consent, raw_gpx_research_consent_at,
            raw_gpx_research_consent_version
        ) values (
            new.id, normalized_username, accepted_at, archive_cfg.terms_version,
            accepted_at, archive_cfg.privacy_version, true, accepted_at,
            archive_cfg.research_consent_version
        );
        return new;
    end if;

    acceptance_source := lower(trim(coalesce(new.raw_user_meta_data ->> 'terms_acceptance_source', '')));
    if acceptance_source not in ('mobile', 'web') then raise exception 'invalid acceptance source'; end if;
    if coalesce(new.raw_user_meta_data ->> 'terms_accepted', 'false') <> 'true'
       or coalesce(new.raw_user_meta_data ->> 'privacy_acknowledged', 'false') <> 'true' then
        raise exception 'current contributor contract is incomplete';
    end if;
    if new.raw_user_meta_data ->> 'terms_version' is distinct from lifecycle_cfg.current_terms_version
       or new.raw_user_meta_data ->> 'privacy_version' is distinct from lifecycle_cfg.current_privacy_version then
        raise exception 'signup document version is not current';
    end if;

    insert into public.user_profiles (
        user_id, username, terms_accepted_at, terms_version,
        privacy_accepted_at, privacy_version,
        raw_gpx_research_consent, raw_gpx_research_consent_at,
        raw_gpx_research_consent_version, raw_gpx_research_consent_withdrawn_at,
        privacy_acknowledged_at, account_state, restriction_reason, restricted_at,
        terms_acceptance_source, last_meaningful_activity_at
    ) values (
        new.id, normalized_username, accepted_at, lifecycle_cfg.current_terms_version,
        accepted_at, lifecycle_cfg.current_privacy_version,
        false, accepted_at, 'legacy-disabled', accepted_at,
        accepted_at, 'active', null, null, acceptance_source, accepted_at
    );
    insert into public.user_legal_events (
        user_id, event_type, terms_version, privacy_version, source, occurred_at
    ) values (
        new.id, 'accepted', lifecycle_cfg.current_terms_version,
        lifecycle_cfg.current_privacy_version, acceptance_source, accepted_at
    ) on conflict (user_id, terms_version, privacy_version, event_type) do nothing;
    return new;
end;
$$;

-- Covers SECURITY DEFINER archive RPCs as well as direct table mutations.
create or replace function public.enforce_current_contributor_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    -- Service jobs/cascades have no end-user uid. Client RPCs retain auth.uid().
    if auth.uid() is not null then
        perform public.require_current_contributor_access();
    end if;
    return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists enforce_contributor_track_mutation on public.user_gpx_tracks;
create trigger enforce_contributor_track_mutation
before insert or update or delete on public.user_gpx_tracks
for each row execute function public.enforce_current_contributor_mutation();

drop trigger if exists enforce_contributor_marker_mutation on public.user_gpx_mushroom_markers;
create trigger enforce_contributor_marker_mutation
before insert or update or delete on public.user_gpx_mushroom_markers
for each row execute function public.enforce_current_contributor_mutation();

create or replace function public.can_upload_user_gpx_object(
    p_name text,
    p_owner_id text,
    p_metadata jsonb
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    caller_id uuid := auth.uid();
begin
    if caller_id is null
       or p_owner_id is distinct from caller_id::text
       or not public.has_current_contributor_access(caller_id) then
        return false;
    end if;
    return exists (
        select 1
          from public.user_gpx_tracks track
         where track.user_id = caller_id
           and track.storage_path = p_name
           and track.status = 'pending_upload'
           and p_name = caller_id::text || '/' || track.id::text || '.gpx.gz'
    );
end;
$$;

drop policy if exists user_profiles_update_username on public.user_profiles;
create policy user_profiles_update_username
    on public.user_profiles for update to authenticated
    using (
        (select auth.uid()) = user_id
        and public.has_current_contributor_access((select auth.uid()))
    )
    with check (
        (select auth.uid()) = user_id
        and public.has_current_contributor_access((select auth.uid()))
    );

drop policy if exists user_gpx_tracks_read_own on public.user_gpx_tracks;
create policy user_gpx_tracks_read_own
    on public.user_gpx_tracks for select to authenticated
    using (
        (select auth.uid()) = user_id
        and public.has_current_contributor_access((select auth.uid()))
    );

drop policy if exists user_gpx_mushroom_markers_read_own on public.user_gpx_mushroom_markers;
create policy user_gpx_mushroom_markers_read_own
    on public.user_gpx_mushroom_markers for select to authenticated
    using (
        (select auth.uid()) = user_id
        and public.has_current_contributor_access((select auth.uid()))
    );

drop policy if exists user_gpx_objects_select_own on storage.objects;
create policy user_gpx_objects_select_own
    on storage.objects for select to authenticated
    using (
        bucket_id = 'user-gpx'
        and owner_id = (select auth.uid()::text)
        and (storage.foldername(name))[1] = (select auth.uid()::text)
        and public.has_current_contributor_access((select auth.uid()))
        and exists (
            select 1 from public.user_gpx_tracks track
             where track.user_id = (select auth.uid())
               and track.storage_path = name
        )
    );

drop policy if exists user_gpx_objects_delete_own on storage.objects;
create policy user_gpx_objects_delete_own
    on storage.objects for delete to authenticated
    using (
        bucket_id = 'user-gpx'
        and owner_id = (select auth.uid()::text)
        and (storage.foldername(name))[1] = (select auth.uid()::text)
        and public.has_current_contributor_access((select auth.uid()))
        and exists (
            select 1 from public.user_gpx_tracks track
             where track.user_id = (select auth.uid())
               and track.storage_path = name
        )
    );

alter table public.user_legal_events enable row level security;
alter table public.account_email_outbox enable row level security;
alter table public.account_lifecycle_job_runs enable row level security;
alter table public.account_lifecycle_config enable row level security;

drop policy if exists user_legal_events_read_own on public.user_legal_events;
create policy user_legal_events_read_own
    on public.user_legal_events for select to authenticated
    using ((select auth.uid()) = user_id);

create or replace function public.get_account_lifecycle_public_config()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
    select jsonb_build_object(
        'lifecycle_enabled', lifecycle_enabled,
        'current_terms_version', current_terms_version,
        'current_privacy_version', current_privacy_version,
        'reaccept_days', reaccept_days
    )
      from public.account_lifecycle_config
     where singleton_id = 1;
$$;

create or replace function public.get_my_account_access()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    caller_id uuid := auth.uid();
    profile public.user_profiles%rowtype;
    cfg public.account_lifecycle_config%rowtype;
begin
    if caller_id is null then raise exception 'authentication required'; end if;
    select * into strict cfg from public.account_lifecycle_config where singleton_id = 1;
    select * into strict profile from public.user_profiles where user_id = caller_id;
    return jsonb_build_object(
        'account_state', profile.account_state,
        'restriction_reason', profile.restriction_reason,
        'terms_version', profile.terms_version,
        'privacy_version', profile.privacy_version,
        'current_terms_version', cfg.current_terms_version,
        'current_privacy_version', cfg.current_privacy_version,
        'legal_notice_first_seen_at', profile.legal_notice_first_seen_at,
        'legal_notice_privacy_version', profile.legal_notice_privacy_version,
        'legal_reaccept_deadline_at', profile.legal_reaccept_deadline_at,
        'last_meaningful_activity_at', profile.last_meaningful_activity_at,
        'inactivity_delete_after', profile.inactivity_delete_after,
        'full_access', public.has_current_contributor_access(caller_id),
        'needs_terms_action', cfg.lifecycle_enabled and (
            profile.account_state <> 'active'
            or profile.terms_version is distinct from cfg.current_terms_version
            or profile.privacy_version is distinct from cfg.current_privacy_version
        )
    );
end;
$$;

create or replace function public.enqueue_account_email(
    p_user_id uuid,
    p_event_type text,
    p_dedupe_key text,
    p_payload jsonb default '{}'::jsonb,
    p_available_at timestamptz default now()
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
    insert into public.account_email_outbox (
        user_id, event_type, dedupe_key, payload, available_at
    ) values (
        p_user_id, p_event_type, p_dedupe_key, coalesce(p_payload, '{}'::jsonb), p_available_at
    ) on conflict (dedupe_key) do nothing;
end;
$$;

create or replace function public.record_my_legal_notice_seen(
    p_terms_version text,
    p_privacy_version text,
    p_source text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    caller_id uuid := auth.uid();
    cfg public.account_lifecycle_config%rowtype;
    profile public.user_profiles%rowtype;
    first_seen timestamptz;
begin
    if caller_id is null then raise exception 'authentication required'; end if;
    if p_source not in ('mobile', 'web') then raise exception 'invalid source'; end if;
    perform pg_advisory_xact_lock(hashtext(caller_id::text));
    select * into strict cfg from public.account_lifecycle_config where singleton_id = 1;
    if not cfg.lifecycle_enabled then raise exception 'account lifecycle is not enabled'; end if;
    if p_terms_version is distinct from cfg.current_terms_version
       or p_privacy_version is distinct from cfg.current_privacy_version then
        raise exception 'document version is not current';
    end if;
    if exists (
        select 1 from public.user_profiles
         where user_id = caller_id
           and (restriction_reason = 'security' or account_state = 'deletion_pending')
    ) then
        raise exception 'account state does not permit legal notice changes';
    end if;

    insert into public.user_legal_events (
        user_id, event_type, terms_version, privacy_version, source
    ) values (caller_id, 'notice_seen', p_terms_version, p_privacy_version, p_source)
    on conflict (user_id, terms_version, privacy_version, event_type) do nothing
    returning occurred_at into first_seen;

    if first_seen is not null then
        update public.account_email_outbox
           set status = 'cancelled', last_error_code = 'new_notice_version', updated_at = now()
         where user_id = caller_id and status in ('pending', 'retry')
           and event_type like 'terms_%';
        update public.user_profiles
           set legal_notice_version = p_terms_version,
               legal_notice_privacy_version = p_privacy_version,
               legal_notice_first_seen_at = first_seen,
               legal_reaccept_deadline_at = first_seen + make_interval(days => cfg.reaccept_days),
               account_state = 'restricted',
               restriction_reason = case
                   when restriction_reason = 'security' then 'security'
                   when restriction_reason = 'inactive' then 'inactive'
                   else 'terms_outdated'
               end,
               restricted_at = coalesce(restricted_at, first_seen),
               deletion_requested_at = null
         where user_id = caller_id;
        perform public.enqueue_account_email(
            caller_id,
            'terms_started',
            caller_id::text || ':terms:' || p_terms_version || ':privacy:' || p_privacy_version || ':started',
            jsonb_build_object(
                'terms_version', p_terms_version,
                'privacy_version', p_privacy_version,
                'deadline', first_seen + make_interval(days => cfg.reaccept_days)
            )
        );
    end if;
    select * into strict profile from public.user_profiles where user_id = caller_id;
    return public.get_my_account_access();
end;
$$;

create or replace function public.accept_current_contributor_terms(
    p_terms_version text,
    p_privacy_version text,
    p_source text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    caller_id uuid := auth.uid();
    cfg public.account_lifecycle_config%rowtype;
    accepted_at timestamptz := now();
begin
    if caller_id is null then raise exception 'authentication required'; end if;
    if p_source not in ('mobile', 'web') then raise exception 'invalid source'; end if;
    perform pg_advisory_xact_lock(hashtext(caller_id::text));
    select * into strict cfg from public.account_lifecycle_config where singleton_id = 1;
    if not cfg.lifecycle_enabled then raise exception 'account lifecycle is not enabled'; end if;
    if p_terms_version is distinct from cfg.current_terms_version
       or p_privacy_version is distinct from cfg.current_privacy_version then
        raise exception 'document version is not current';
    end if;
    if exists (
        select 1 from public.user_profiles
         where user_id = caller_id
           and (restriction_reason = 'security' or account_state = 'deletion_pending')
    ) then
        raise exception 'account state does not permit acceptance';
    end if;

    -- Acceptance from the displayed screen is also authoritative first notice.
    perform public.record_my_legal_notice_seen(p_terms_version, p_privacy_version, p_source);
    insert into public.user_legal_events (
        user_id, event_type, terms_version, privacy_version, source, occurred_at
    ) values (caller_id, 'accepted', p_terms_version, p_privacy_version, p_source, accepted_at)
    on conflict (user_id, terms_version, privacy_version, event_type) do nothing;
    update public.user_profiles
       set terms_accepted_at = accepted_at,
           terms_version = p_terms_version,
           privacy_accepted_at = accepted_at,
           privacy_version = p_privacy_version,
           privacy_acknowledged_at = accepted_at,
           terms_acceptance_source = p_source,
           account_state = 'active',
           restriction_reason = null,
           restricted_at = null,
           deletion_requested_at = null,
           last_meaningful_activity_at = accepted_at,
           inactivity_restricted_at = null,
           inactivity_delete_after = null
     where user_id = caller_id;
    update public.account_email_outbox
       set status = 'cancelled', last_error_code = 'terms_accepted', updated_at = now()
     where user_id = caller_id and status in ('pending', 'retry')
       and event_type like 'terms_%';
    return public.get_my_account_access();
end;
$$;

create or replace function public.refuse_current_contributor_terms(
    p_terms_version text,
    p_privacy_version text,
    p_source text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    caller_id uuid := auth.uid();
    refused_at timestamptz := now();
begin
    if caller_id is null then raise exception 'authentication required'; end if;
    perform public.record_my_legal_notice_seen(p_terms_version, p_privacy_version, p_source);
    insert into public.user_legal_events (
        user_id, event_type, terms_version, privacy_version, source, occurred_at
    ) values (caller_id, 'refused', p_terms_version, p_privacy_version, p_source, refused_at)
    on conflict (user_id, terms_version, privacy_version, event_type) do nothing;
    update public.user_profiles
       set account_state = 'restricted',
           restriction_reason = 'terms_refused',
           restricted_at = coalesce(restricted_at, refused_at),
           last_meaningful_activity_at = refused_at
     where user_id = caller_id;
    return public.get_my_account_access();
end;
$$;

create or replace function public.record_my_meaningful_activity(p_activity_kind text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    caller_id uuid := auth.uid();
    activity_at timestamptz := now();
    cfg public.account_lifecycle_config%rowtype;
begin
    if caller_id is null then raise exception 'authentication required'; end if;
    if p_activity_kind not in ('interactive_login', 'foreground_session', 'account_action') then
        raise exception 'invalid meaningful activity kind';
    end if;
    perform pg_advisory_xact_lock(hashtext(caller_id::text));
    select * into strict cfg from public.account_lifecycle_config where singleton_id = 1;
    update public.user_profiles
       set last_meaningful_activity_at = activity_at,
           account_state = case
               when restriction_reason = 'inactive'
                    and terms_version = cfg.current_terms_version
                    and privacy_version = cfg.current_privacy_version then 'active'
               when restriction_reason = 'inactive' then 'restricted'
               else account_state
           end,
           restriction_reason = case
               when restriction_reason = 'inactive'
                    and terms_version = cfg.current_terms_version
                    and privacy_version = cfg.current_privacy_version then null
               when restriction_reason = 'inactive' then 'terms_outdated'
               else restriction_reason
           end,
           restricted_at = case
               when restriction_reason = 'inactive'
                    and terms_version = cfg.current_terms_version
                    and privacy_version = cfg.current_privacy_version then null
               when restriction_reason = 'inactive' then activity_at
               else restricted_at
           end,
           deletion_requested_at = case
               when restriction_reason = 'inactive' then null
               else deletion_requested_at
           end,
           inactivity_restricted_at = null,
           inactivity_delete_after = null
     where user_id = caller_id
       and not (account_state = 'deletion_pending' and restriction_reason is distinct from 'inactive');
    update public.account_email_outbox
       set status = 'cancelled', last_error_code = 'activity_resumed', updated_at = now()
     where user_id = caller_id and status in ('pending', 'retry')
       and event_type like 'inactive_%';
    return public.get_my_account_access();
end;
$$;

create or replace function public.enqueue_due_account_email(
    p_user_id uuid,
    p_event_type text,
    p_anchor text,
    p_payload jsonb
)
returns void
language sql
security definer
set search_path = ''
as $$
    select public.enqueue_account_email(
        p_user_id,
        p_event_type,
        p_user_id::text || ':' || p_anchor || ':' || p_event_type,
        p_payload
    );
$$;

create or replace function public.preview_account_lifecycle_daily(p_now timestamptz default now())
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
    with cfg as (
        select * from public.account_lifecycle_config where singleton_id = 1
    )
    select jsonb_build_object(
        'lifecycle_enabled', cfg.lifecycle_enabled,
        'terms_to_restrict', (
            select count(*) from public.user_profiles p
             where cfg.lifecycle_enabled
               and p.account_state = 'active'
               and (p.terms_version is distinct from cfg.current_terms_version
                    or p.privacy_version is distinct from cfg.current_privacy_version)
        ),
        'terms_to_expire', (
            select count(*) from public.user_profiles p
             where cfg.lifecycle_enabled and p.account_state = 'restricted'
               and p.restriction_reason in ('terms_outdated', 'terms_refused')
               and p.legal_reaccept_deadline_at <= p_now
        ),
        'inactivity_to_restrict', (
            select count(*) from public.user_profiles p
             where cfg.lifecycle_enabled and p.account_state = 'active'
               and p.last_meaningful_activity_at + make_interval(months => cfg.inactivity_restrict_months) <= p_now
        ),
        'inactivity_to_expire', (
            select count(*) from public.user_profiles p
             where cfg.lifecycle_enabled and p.account_state = 'restricted'
               and p.restriction_reason = 'inactive'
               and p.inactivity_delete_after <= p_now
        ),
        'dispatchable_emails', (
            select count(*) from public.account_email_outbox o
             where o.status in ('pending', 'retry') and o.available_at <= p_now
        )
    ) from cfg;
$$;

create or replace function public.prepare_account_lifecycle_daily(p_now timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    cfg public.account_lifecycle_config%rowtype;
    lifecycle_profile record;
    changed_terms integer := 0;
    changed_inactive integer := 0;
    pending_deletion integer := 0;
begin
    select * into strict cfg from public.account_lifecycle_config where singleton_id = 1 for update;
    if not cfg.lifecycle_enabled then
        return jsonb_build_object('lifecycle_enabled', false, 'changed', 0);
    end if;

    -- A material version change restricts access, but starts no deadline.
    update public.user_profiles
       set account_state = 'restricted', restriction_reason = 'terms_outdated',
           restricted_at = p_now, legal_notice_version = null,
           legal_notice_privacy_version = null,
           legal_notice_first_seen_at = null, legal_reaccept_deadline_at = null
     where account_state = 'active'
       and (terms_version is distinct from cfg.current_terms_version
            or privacy_version is distinct from cfg.current_privacy_version);
    get diagnostics changed_terms = row_count;
    update public.account_email_outbox outbox
       set status = 'cancelled', last_error_code = 'document_version_changed', updated_at = now()
     where outbox.status in ('pending', 'retry') and outbox.event_type like 'terms_%'
       and exists (
           select 1 from public.user_profiles restricted_profile
            where restricted_profile.user_id = outbox.user_id
              and restricted_profile.account_state = 'restricted'
              and restricted_profile.restriction_reason = 'terms_outdated'
              and restricted_profile.legal_notice_first_seen_at is null
       );

    -- First inactivity transition, anchored only to meaningful activity.
    for lifecycle_profile in
        update public.user_profiles
           set account_state = 'restricted', restriction_reason = 'inactive',
               restricted_at = p_now, inactivity_restricted_at = p_now,
               inactivity_delete_after = last_meaningful_activity_at
                   + make_interval(months => cfg.inactivity_delete_months)
         where account_state = 'active'
           and last_meaningful_activity_at
               + make_interval(months => cfg.inactivity_restrict_months) <= p_now
         returning user_id, inactivity_restricted_at, inactivity_delete_after
    loop
        changed_inactive := changed_inactive + 1;
        perform public.enqueue_due_account_email(
            lifecycle_profile.user_id, 'inactive_started',
            'inactive:' || lifecycle_profile.inactivity_restricted_at::text,
            jsonb_build_object('deadline', lifecycle_profile.inactivity_delete_after)
        );
    end loop;

    -- Terms reminders are based only on authenticated first presentation.
    for lifecycle_profile in
        select user_id, legal_notice_version, legal_notice_privacy_version,
               legal_notice_first_seen_at, legal_reaccept_deadline_at
          from public.user_profiles
         where account_state = 'restricted'
           and restriction_reason in ('terms_outdated', 'terms_refused')
           and legal_notice_first_seen_at is not null
           and legal_reaccept_deadline_at > p_now
    loop
        if lifecycle_profile.legal_notice_first_seen_at + interval '6 months' <= p_now then
            perform public.enqueue_due_account_email(lifecycle_profile.user_id, 'terms_six_months',
                'terms:' || lifecycle_profile.legal_notice_version || ':privacy:' || lifecycle_profile.legal_notice_privacy_version,
                jsonb_build_object('terms_version', lifecycle_profile.legal_notice_version, 'privacy_version', lifecycle_profile.legal_notice_privacy_version, 'deadline', lifecycle_profile.legal_reaccept_deadline_at));
        end if;
        if lifecycle_profile.legal_reaccept_deadline_at - interval '30 days' <= p_now then
            perform public.enqueue_due_account_email(lifecycle_profile.user_id, 'terms_30_days',
                'terms:' || lifecycle_profile.legal_notice_version || ':privacy:' || lifecycle_profile.legal_notice_privacy_version,
                jsonb_build_object('terms_version', lifecycle_profile.legal_notice_version, 'privacy_version', lifecycle_profile.legal_notice_privacy_version, 'deadline', lifecycle_profile.legal_reaccept_deadline_at));
        end if;
        if lifecycle_profile.legal_reaccept_deadline_at - interval '7 days' <= p_now then
            perform public.enqueue_due_account_email(lifecycle_profile.user_id, 'terms_7_days',
                'terms:' || lifecycle_profile.legal_notice_version || ':privacy:' || lifecycle_profile.legal_notice_privacy_version,
                jsonb_build_object('terms_version', lifecycle_profile.legal_notice_version, 'privacy_version', lifecycle_profile.legal_notice_privacy_version, 'deadline', lifecycle_profile.legal_reaccept_deadline_at));
        end if;
    end loop;

    -- Inactivity reminders use the 24-to-36 month warning window.
    for lifecycle_profile in
        select user_id, inactivity_restricted_at, inactivity_delete_after
          from public.user_profiles
         where account_state = 'restricted' and restriction_reason = 'inactive'
           and inactivity_delete_after > p_now
    loop
        if lifecycle_profile.inactivity_restricted_at + interval '6 months' <= p_now then
            perform public.enqueue_due_account_email(lifecycle_profile.user_id, 'inactive_six_months',
                'inactive:' || lifecycle_profile.inactivity_restricted_at::text,
                jsonb_build_object('deadline', lifecycle_profile.inactivity_delete_after));
        end if;
        if lifecycle_profile.inactivity_delete_after - interval '30 days' <= p_now then
            perform public.enqueue_due_account_email(lifecycle_profile.user_id, 'inactive_30_days',
                'inactive:' || lifecycle_profile.inactivity_restricted_at::text,
                jsonb_build_object('deadline', lifecycle_profile.inactivity_delete_after));
        end if;
        if lifecycle_profile.inactivity_delete_after - interval '7 days' <= p_now then
            perform public.enqueue_due_account_email(lifecycle_profile.user_id, 'inactive_7_days',
                'inactive:' || lifecycle_profile.inactivity_restricted_at::text,
                jsonb_build_object('deadline', lifecycle_profile.inactivity_delete_after));
        end if;
    end loop;

    for lifecycle_profile in
        update public.user_profiles
           set account_state = 'deletion_pending', deletion_requested_at = p_now
         where account_state = 'restricted'
           and restriction_reason in ('terms_outdated', 'terms_refused')
           and legal_reaccept_deadline_at <= p_now
         returning user_id, legal_notice_version, legal_notice_privacy_version, legal_reaccept_deadline_at
    loop
        pending_deletion := pending_deletion + 1;
        perform public.enqueue_due_account_email(lifecycle_profile.user_id, 'terms_expired',
            'terms:' || lifecycle_profile.legal_notice_version || ':privacy:' || lifecycle_profile.legal_notice_privacy_version,
            jsonb_build_object('terms_version', lifecycle_profile.legal_notice_version, 'privacy_version', lifecycle_profile.legal_notice_privacy_version, 'deadline', lifecycle_profile.legal_reaccept_deadline_at));
    end loop;

    for lifecycle_profile in
        update public.user_profiles
           set account_state = 'deletion_pending', deletion_requested_at = p_now
         where account_state = 'restricted' and restriction_reason = 'inactive'
           and inactivity_delete_after <= p_now
         returning user_id, inactivity_restricted_at, inactivity_delete_after
    loop
        pending_deletion := pending_deletion + 1;
        perform public.enqueue_due_account_email(lifecycle_profile.user_id, 'inactive_expired',
            'inactive:' || lifecycle_profile.inactivity_restricted_at::text,
            jsonb_build_object('deadline', lifecycle_profile.inactivity_delete_after));
    end loop;

    return jsonb_build_object(
        'lifecycle_enabled', true,
        'terms_restricted', changed_terms,
        'inactivity_restricted', changed_inactive,
        'deletion_pending', pending_deletion
    );
end;
$$;

create or replace function public.claim_account_lifecycle_daily_run(
    p_run_date date,
    p_owner_token uuid,
    p_lease_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare run_row public.account_lifecycle_job_runs%rowtype;
begin
    if p_lease_seconds not between 60 and 86400 then raise exception 'invalid lease'; end if;
    if exists (
        select 1 from public.account_lifecycle_job_runs
         where status = 'running' and lease_until > now()
           and owner_token is distinct from p_owner_token
    ) then
        return jsonb_build_object('claimed', false, 'reason', 'locked');
    end if;
    insert into public.account_lifecycle_job_runs (run_date)
    values (p_run_date) on conflict (run_date) do nothing;
    select * into strict run_row from public.account_lifecycle_job_runs
     where run_date = p_run_date for update;
    if run_row.status = 'completed' then
        return jsonb_build_object('claimed', false, 'reason', 'completed');
    end if;
    if run_row.status = 'running' and run_row.lease_until > now()
       and run_row.owner_token is distinct from p_owner_token then
        return jsonb_build_object('claimed', false, 'reason', 'locked');
    end if;
    update public.account_lifecycle_job_runs
       set status = 'running', owner_token = p_owner_token,
           lease_until = now() + make_interval(secs => p_lease_seconds),
           started_at = coalesce(started_at, now()), updated_at = now()
     where run_date = p_run_date returning * into run_row;
    return jsonb_build_object(
        'claimed', true, 'attempted_count', run_row.attempted_count,
        'sent_count', run_row.sent_count
    );
end;
$$;

create or replace function public.claim_next_account_lifecycle_email(
    p_run_date date,
    p_owner_token uuid,
    p_daily_limit integer,
    p_claim_timeout_seconds integer default 900
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    cfg public.account_lifecycle_config%rowtype;
    run_row public.account_lifecycle_job_runs%rowtype;
    email_row public.account_email_outbox%rowtype;
    recipient text;
begin
    select * into strict cfg from public.account_lifecycle_config where singleton_id = 1;
    select * into strict run_row from public.account_lifecycle_job_runs
     where run_date = p_run_date for update;
    if run_row.status <> 'running' or run_row.owner_token is distinct from p_owner_token
       or run_row.lease_until <= now() then raise exception 'daily run lock is not held'; end if;
    if run_row.attempted_count >= least(p_daily_limit, cfg.dispatcher_daily_limit) then
        return jsonb_build_object('claimed', false, 'reason', 'daily_limit');
    end if;

    update public.account_email_outbox
       set status = 'retry', claim_token = null, claimed_at = null,
           available_at = now(), updated_at = now(), last_error_code = 'claim_timeout'
     where status = 'sending'
       and claimed_at < now() - make_interval(secs => p_claim_timeout_seconds);

    select * into email_row
      from public.account_email_outbox
     where status in ('pending', 'retry') and available_at <= now()
       and attempt_count < cfg.dispatcher_max_attempts
     order by available_at, id
     for update skip locked limit 1;
    if not found then return jsonb_build_object('claimed', false, 'reason', 'empty'); end if;

    select email into recipient from auth.users where id = email_row.user_id;
    if recipient is null then
        update public.account_email_outbox
           set status = 'dead', last_error_code = 'recipient_missing', updated_at = now()
         where id = email_row.id;
        return jsonb_build_object('claimed', false, 'reason', 'recipient_missing');
    end if;

    email_row.claim_token := gen_random_uuid();
    update public.account_email_outbox
       set status = 'sending', claim_token = email_row.claim_token,
           claimed_at = now(), attempt_count = attempt_count + 1, updated_at = now()
     where id = email_row.id;
    update public.account_lifecycle_job_runs
       set attempted_count = attempted_count + 1, updated_at = now()
     where run_date = p_run_date;
    return jsonb_build_object(
        'claimed', true, 'id', email_row.id, 'claim_token', email_row.claim_token,
        'recipient', recipient, 'event_type', email_row.event_type,
        'payload', email_row.payload, 'attempt_count', email_row.attempt_count + 1
    );
end;
$$;

create or replace function public.complete_account_lifecycle_email(
    p_run_date date, p_owner_token uuid, p_email_id bigint, p_claim_token uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
    if not exists (
        select 1 from public.account_lifecycle_job_runs
         where run_date = p_run_date and status = 'running' and owner_token = p_owner_token
    ) then raise exception 'daily run lock is not held'; end if;
    update public.account_email_outbox
       set status = 'sent', sent_at = now(), claim_token = null, claimed_at = null,
           last_error_code = null, updated_at = now()
     where id = p_email_id and status = 'sending' and claim_token = p_claim_token;
    if found then
        update public.account_lifecycle_job_runs set sent_count = sent_count + 1, updated_at = now()
         where run_date = p_run_date;
    end if;
end;
$$;

create or replace function public.fail_account_lifecycle_email(
    p_email_id bigint, p_claim_token uuid, p_error_code text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare cfg public.account_lifecycle_config%rowtype;
begin
    select * into strict cfg from public.account_lifecycle_config where singleton_id = 1;
    update public.account_email_outbox
       set status = case when attempt_count >= cfg.dispatcher_max_attempts then 'dead' else 'retry' end,
           available_at = now() + make_interval(secs => least(
               86400, cfg.dispatcher_backoff_seconds * power(2, greatest(0, attempt_count - 1))::integer
           )),
           claim_token = null, claimed_at = null,
           last_error_code = left(coalesce(p_error_code, 'smtp_error'), 80), updated_at = now()
     where id = p_email_id and status = 'sending' and claim_token = p_claim_token;
end;
$$;

create or replace function public.finish_account_lifecycle_daily_run(
    p_run_date date, p_owner_token uuid, p_success boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
    update public.account_lifecycle_job_runs
       set status = case when p_success then 'completed' else 'available' end,
           owner_token = null, lease_until = null,
           completed_at = case when p_success then now() else completed_at end,
           updated_at = now()
     where run_date = p_run_date and status = 'running' and owner_token = p_owner_token;
end;
$$;

-- Canonical, fail-closed datasets for future trusted modelling jobs.
create or replace function public.trusted_current_contributor_gpx_tracks()
returns setof public.user_gpx_tracks
language sql
stable
security definer
set search_path = ''
as $$
    select track.* from public.user_gpx_tracks track
    join public.user_profiles profile on profile.user_id = track.user_id
    join public.account_lifecycle_config cfg on cfg.singleton_id = 1
    where cfg.lifecycle_enabled and track.status = 'ready'
      and profile.account_state = 'active'
      and profile.terms_version = cfg.current_terms_version
      and profile.privacy_version = cfg.current_privacy_version
      and profile.privacy_acknowledged_at is not null;
$$;

create or replace function public.trusted_current_contributor_gpx_markers()
returns setof public.user_gpx_mushroom_markers
language sql
stable
security definer
set search_path = ''
as $$
    select marker.* from public.user_gpx_mushroom_markers marker
    join public.user_profiles profile on profile.user_id = marker.user_id
    join public.account_lifecycle_config cfg on cfg.singleton_id = 1
    where cfg.lifecycle_enabled and profile.account_state = 'active'
      and profile.terms_version = cfg.current_terms_version
      and profile.privacy_version = cfg.current_privacy_version
      and profile.privacy_acknowledged_at is not null;
$$;

create or replace function public.preview_expired_pending_gpx_uploads(
    p_now timestamptz default now()
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
    select jsonb_build_object(
        'ttl_hours', cfg.pending_upload_ttl_hours,
        'cleanup_limit', cfg.pending_upload_cleanup_limit,
        'eligible', (
            select count(*) from public.user_gpx_tracks track
             where track.status = 'pending_upload'
               and track.created_at <= p_now - make_interval(hours => cfg.pending_upload_ttl_hours)
        ),
        'reclaimable_claims', (
            select count(*) from public.user_gpx_tracks track
             where track.status = 'cleanup_pending'
               and track.pending_cleanup_claimed_at <= p_now - interval '15 minutes'
        )
    )
    from public.account_lifecycle_config cfg
    where cfg.singleton_id = 1;
$$;

create or replace function public.claim_expired_pending_gpx_uploads(
    p_owner_token uuid,
    p_now timestamptz default now(),
    p_limit integer default null
)
returns table(id uuid, storage_path text, claim_token uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
    cfg public.account_lifecycle_config%rowtype;
    max_claims integer;
begin
    if p_owner_token is null then raise exception 'cleanup owner token is required'; end if;
    select * into strict cfg from public.account_lifecycle_config where singleton_id = 1;
    max_claims := least(coalesce(p_limit, cfg.pending_upload_cleanup_limit), cfg.pending_upload_cleanup_limit);
    if max_claims not between 1 and 500 then raise exception 'invalid pending upload cleanup limit'; end if;

    return query
    with candidates as (
        select track.id
          from public.user_gpx_tracks track
         where (
                track.status = 'pending_upload'
            and track.created_at <= p_now - make_interval(hours => cfg.pending_upload_ttl_hours)
         ) or (
                track.status = 'cleanup_pending'
            and track.pending_cleanup_claimed_at <= p_now - interval '15 minutes'
         )
         order by track.created_at
         limit max_claims
         for update skip locked
    ), claimed as (
        update public.user_gpx_tracks track
           set status = 'cleanup_pending',
               pending_cleanup_token = p_owner_token,
               pending_cleanup_claimed_at = p_now,
               updated_at = p_now
          from candidates
         where track.id = candidates.id
         returning track.id, track.storage_path, track.pending_cleanup_token
    )
    select claimed.id, claimed.storage_path, claimed.pending_cleanup_token from claimed;
end;
$$;

create or replace function public.complete_expired_pending_gpx_upload_cleanup(
    p_track_id uuid,
    p_claim_token uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
    delete from public.user_gpx_tracks track
     where track.id = p_track_id
       and track.status = 'cleanup_pending'
       and track.pending_cleanup_token = p_claim_token
       and not exists (
           select 1 from storage.objects object
            where object.bucket_id = 'user-gpx' and object.name = track.storage_path
       );
    if not found then raise exception 'pending upload cleanup claim is no longer valid'; end if;
end;
$$;

create or replace function public.fail_expired_pending_gpx_upload_cleanup(
    p_track_id uuid,
    p_claim_token uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
    update public.user_gpx_tracks
       set status = 'pending_upload', pending_cleanup_token = null,
           pending_cleanup_claimed_at = null, updated_at = now()
     where id = p_track_id and status = 'cleanup_pending'
       and pending_cleanup_token = p_claim_token;
    if not found then raise exception 'pending upload cleanup claim is no longer valid'; end if;
end;
$$;

create or replace function public.account_lifecycle_setup_audit()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
    select jsonb_build_object(
        'config', (select to_jsonb(cfg) from public.account_lifecycle_config cfg where singleton_id = 1),
        'profiles_by_state', coalesce((select jsonb_object_agg(account_state, n) from (
            select account_state, count(*) n from public.user_profiles group by account_state
        ) s), '{}'::jsonb),
        'outbox_by_status', coalesce((select jsonb_object_agg(status, n) from (
            select status, count(*) n from public.account_email_outbox group by status
        ) s), '{}'::jsonb),
        'legal_events', (select count(*) from public.user_legal_events),
        'gates', jsonb_build_object(
            'track_trigger', exists (select 1 from pg_trigger where tgname = 'enforce_contributor_track_mutation'),
            'marker_trigger', exists (select 1 from pg_trigger where tgname = 'enforce_contributor_marker_mutation'),
            'pending_upload_cleanup', exists (
                select 1 from pg_proc where proname = 'claim_expired_pending_gpx_uploads'
            )
        )
    );
$$;

revoke all on public.account_lifecycle_config from public, anon, authenticated;
revoke all on public.user_legal_events from public, anon, authenticated;
revoke all on public.account_email_outbox from public, anon, authenticated;
revoke all on public.account_lifecycle_job_runs from public, anon, authenticated;
grant select on public.user_legal_events to authenticated;
grant all on public.account_lifecycle_config, public.user_legal_events,
    public.account_email_outbox, public.account_lifecycle_job_runs to service_role;

revoke all on function public.has_current_contributor_access(uuid) from public, anon;
grant execute on function public.has_current_contributor_access(uuid) to authenticated, service_role;
revoke all on function public.require_current_contributor_access() from public, anon;
grant execute on function public.require_current_contributor_access() to authenticated, service_role;
revoke all on function public.enforce_current_contributor_mutation() from public, anon, authenticated;
revoke all on function public.get_account_lifecycle_public_config() from public;
grant execute on function public.get_account_lifecycle_public_config() to anon, authenticated, service_role;
revoke all on function public.get_my_account_access() from public, anon;
grant execute on function public.get_my_account_access() to authenticated, service_role;
revoke all on function public.record_my_legal_notice_seen(text, text, text) from public, anon;
revoke all on function public.accept_current_contributor_terms(text, text, text) from public, anon;
revoke all on function public.refuse_current_contributor_terms(text, text, text) from public, anon;
revoke all on function public.record_my_meaningful_activity(text) from public, anon;
grant execute on function public.record_my_legal_notice_seen(text, text, text) to authenticated;
grant execute on function public.accept_current_contributor_terms(text, text, text) to authenticated;
grant execute on function public.refuse_current_contributor_terms(text, text, text) to authenticated;
grant execute on function public.record_my_meaningful_activity(text) to authenticated;

revoke all on function public.set_my_raw_gpx_research_consent(boolean) from authenticated;

revoke all on function public.enqueue_account_email(uuid, text, text, jsonb, timestamptz) from public, anon, authenticated;
revoke all on function public.enqueue_due_account_email(uuid, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.preview_account_lifecycle_daily(timestamptz) from public, anon, authenticated;
revoke all on function public.prepare_account_lifecycle_daily(timestamptz) from public, anon, authenticated;
revoke all on function public.claim_account_lifecycle_daily_run(date, uuid, integer) from public, anon, authenticated;
revoke all on function public.claim_next_account_lifecycle_email(date, uuid, integer, integer) from public, anon, authenticated;
revoke all on function public.complete_account_lifecycle_email(date, uuid, bigint, uuid) from public, anon, authenticated;
revoke all on function public.fail_account_lifecycle_email(bigint, uuid, text) from public, anon, authenticated;
revoke all on function public.finish_account_lifecycle_daily_run(date, uuid, boolean) from public, anon, authenticated;
revoke all on function public.trusted_current_contributor_gpx_tracks() from public, anon, authenticated;
revoke all on function public.trusted_current_contributor_gpx_markers() from public, anon, authenticated;
revoke all on function public.preview_expired_pending_gpx_uploads(timestamptz) from public, anon, authenticated;
revoke all on function public.claim_expired_pending_gpx_uploads(uuid, timestamptz, integer) from public, anon, authenticated;
revoke all on function public.complete_expired_pending_gpx_upload_cleanup(uuid, uuid) from public, anon, authenticated;
revoke all on function public.fail_expired_pending_gpx_upload_cleanup(uuid, uuid) from public, anon, authenticated;
revoke all on function public.account_lifecycle_setup_audit() from public, anon, authenticated;

grant execute on function public.preview_account_lifecycle_daily(timestamptz) to service_role;
grant execute on function public.prepare_account_lifecycle_daily(timestamptz) to service_role;
grant execute on function public.claim_account_lifecycle_daily_run(date, uuid, integer) to service_role;
grant execute on function public.claim_next_account_lifecycle_email(date, uuid, integer, integer) to service_role;
grant execute on function public.complete_account_lifecycle_email(date, uuid, bigint, uuid) to service_role;
grant execute on function public.fail_account_lifecycle_email(bigint, uuid, text) to service_role;
grant execute on function public.finish_account_lifecycle_daily_run(date, uuid, boolean) to service_role;
grant execute on function public.trusted_current_contributor_gpx_tracks() to service_role;
grant execute on function public.trusted_current_contributor_gpx_markers() to service_role;
grant execute on function public.preview_expired_pending_gpx_uploads(timestamptz) to service_role;
grant execute on function public.claim_expired_pending_gpx_uploads(uuid, timestamptz, integer) to service_role;
grant execute on function public.complete_expired_pending_gpx_upload_cleanup(uuid, uuid) to service_role;
grant execute on function public.fail_expired_pending_gpx_upload_cleanup(uuid, uuid) to service_role;
grant execute on function public.account_lifecycle_setup_audit() to service_role;

comment on table public.account_email_outbox is
    'Idempotent metadata-only service-email outbox. Recipient is resolved from auth.users only while claiming.';
comment on function public.record_my_legal_notice_seen(text, text, text) is
    'Authoritative first authenticated presentation. Email delivery alone never starts the 365-day deadline.';
comment on function public.record_my_meaningful_activity(text) is
    'Explicit foreground/authenticated activity only; token refresh and background polling must never call it.';

-- Preparatory contributor-account contract.
--
-- This migration records the target legal/account state without enabling the
-- lifecycle gates. Enforcement, reacceptance RPCs and deletion jobs belong to
-- the following rollout task.

alter table public.user_profiles
    add column if not exists privacy_acknowledged_at timestamptz,
    add column if not exists account_state text,
    add column if not exists restriction_reason text,
    add column if not exists restricted_at timestamptz,
    add column if not exists terms_acceptance_source text,
    add column if not exists legal_notice_version text,
    add column if not exists legal_notice_first_seen_at timestamptz,
    add column if not exists legal_reaccept_deadline_at timestamptz,
    add column if not exists last_meaningful_activity_at timestamptz,
    add column if not exists deletion_requested_at timestamptz;

-- Existing users have not accepted the contributor contract. The WHERE clause
-- makes this backfill safe to rerun and avoids resetting future active users.
update public.user_profiles
   set privacy_acknowledged_at = coalesce(privacy_acknowledged_at, privacy_accepted_at),
       account_state = 'restricted',
       restriction_reason = 'terms_outdated',
       restricted_at = coalesce(restricted_at, now()),
       terms_acceptance_source = coalesce(terms_acceptance_source, 'legacy_signup'),
       last_meaningful_activity_at = coalesce(last_meaningful_activity_at, now())
 where account_state is null;

alter table public.user_profiles
    alter column account_state set default 'restricted',
    alter column account_state set not null,
    alter column restriction_reason set default 'terms_outdated',
    -- This migration is applied before the lifecycle replacement signup
    -- trigger. Keep the old signup trigger valid during that interval: a new
    -- profile defaults to restricted and must also satisfy the state check.
    alter column restricted_at set default now(),
    alter column terms_acceptance_source set default 'legacy_signup',
    alter column terms_acceptance_source set not null,
    alter column last_meaningful_activity_at set default now(),
    alter column last_meaningful_activity_at set not null;

do $$
begin
    if not exists (
        select 1 from pg_constraint
         where conrelid = 'public.user_profiles'::regclass
           and conname = 'user_profiles_account_state_valid'
    ) then
        alter table public.user_profiles
            add constraint user_profiles_account_state_valid
            check (account_state in ('active', 'restricted', 'deletion_pending'));
    end if;

    if not exists (
        select 1 from pg_constraint
         where conrelid = 'public.user_profiles'::regclass
           and conname = 'user_profiles_restriction_reason_valid'
    ) then
        alter table public.user_profiles
            add constraint user_profiles_restriction_reason_valid
            check (
                restriction_reason is null
                or restriction_reason in ('terms_outdated', 'terms_refused', 'inactive', 'security')
            );
    end if;

    if not exists (
        select 1 from pg_constraint
         where conrelid = 'public.user_profiles'::regclass
           and conname = 'user_profiles_acceptance_source_valid'
    ) then
        alter table public.user_profiles
            add constraint user_profiles_acceptance_source_valid
            check (terms_acceptance_source in ('legacy_signup', 'mobile', 'web', 'admin_migration'));
    end if;

    if not exists (
        select 1 from pg_constraint
         where conrelid = 'public.user_profiles'::regclass
           and conname = 'user_profiles_account_state_consistent'
    ) then
        alter table public.user_profiles
            add constraint user_profiles_account_state_consistent
            check (
                (
                    account_state = 'active'
                    and restriction_reason is null
                    and restricted_at is null
                    and deletion_requested_at is null
                )
                or (
                    account_state = 'restricted'
                    and restriction_reason is not null
                    and restricted_at is not null
                    and deletion_requested_at is null
                )
                or (
                    account_state = 'deletion_pending'
                    and deletion_requested_at is not null
                )
            );
    end if;

    if not exists (
        select 1 from pg_constraint
         where conrelid = 'public.user_profiles'::regclass
           and conname = 'user_profiles_legal_notice_timing_valid'
    ) then
        alter table public.user_profiles
            add constraint user_profiles_legal_notice_timing_valid
            check (
                (
                    legal_notice_first_seen_at is null
                    and legal_reaccept_deadline_at is null
                )
                or (
                    legal_notice_first_seen_at is not null
                    and legal_notice_version is not null
                    and legal_reaccept_deadline_at > legal_notice_first_seen_at
                )
            );
    end if;
end
$$;

create index if not exists user_profiles_account_state_idx
    on public.user_profiles (account_state, restriction_reason);

comment on column public.user_profiles.account_state is
    'Contributor-account lifecycle state: active, restricted or deletion_pending.';
comment on column public.user_profiles.restriction_reason is
    'Reason for restricted access: terms_outdated, terms_refused, inactive or security.';
comment on column public.user_profiles.privacy_acknowledged_at is
    'Timestamp at which the privacy notice was acknowledged; privacy is not a consent contract.';
comment on column public.user_profiles.raw_gpx_research_consent is
    'Legacy field retained for compatibility and audit only; it does not authorize target contributor processing.';
comment on column public.user_profiles.raw_gpx_research_consent_at is
    'Legacy field retained for compatibility and audit only.';
comment on column public.user_profiles.raw_gpx_research_consent_version is
    'Legacy field retained for compatibility and audit only.';
comment on column public.user_profiles.raw_gpx_research_consent_withdrawn_at is
    'Legacy field retained for compatibility and audit only.';

create or replace function public.user_account_contract_setup_audit()
returns jsonb
language sql
security definer
set search_path = ''
as $$
    select jsonb_build_object(
        'required_columns', jsonb_build_object(
            'account_state', exists (
                select 1 from information_schema.columns
                 where table_schema = 'public'
                   and table_name = 'user_profiles'
                   and column_name = 'account_state'
            ),
            'restriction_reason', exists (
                select 1 from information_schema.columns
                 where table_schema = 'public'
                   and table_name = 'user_profiles'
                   and column_name = 'restriction_reason'
            ),
            'privacy_acknowledged_at', exists (
                select 1 from information_schema.columns
                 where table_schema = 'public'
                   and table_name = 'user_profiles'
                   and column_name = 'privacy_acknowledged_at'
            ),
            'last_meaningful_activity_at', exists (
                select 1 from information_schema.columns
                 where table_schema = 'public'
                   and table_name = 'user_profiles'
                   and column_name = 'last_meaningful_activity_at'
            )
        ),
        'states', coalesce((
            select jsonb_object_agg(account_state, account_count)
              from (
                    select account_state, count(*) as account_count
                      from public.user_profiles
                     group by account_state
                   ) grouped_states
        ), '{}'::jsonb),
        'legacy_consent_rows', (
            select count(*) from public.user_profiles
             where raw_gpx_research_consent
        ),
        'invalid_active_rows', (
            select count(*) from public.user_profiles
             where account_state = 'active'
               and (restriction_reason is not null or restricted_at is not null)
        )
    );
$$;

revoke all on function public.user_account_contract_setup_audit() from public, anon, authenticated;
grant execute on function public.user_account_contract_setup_audit() to service_role;

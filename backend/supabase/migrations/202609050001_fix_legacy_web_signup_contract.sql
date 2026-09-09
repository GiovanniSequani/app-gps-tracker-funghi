-- Follow-up to 202609040001.
--
-- The deployed web client sends this transitional payload while lifecycle is
-- disabled:
--   username, terms_accepted=true, privacy_accepted=true
-- It intentionally omits raw_gpx_research_consent.  Accept that payload, but
-- never manufacture research consent: store the legacy consent as disabled.
--
-- Prerequisite: 202608290001, 202608310001 and 202609040001.

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
    archive_contract_complete boolean;
    legacy_research_consent boolean;
    prepared_contract_complete boolean;
begin
    select * into strict archive_cfg from public.gpx_archive_config where singleton_id = 1;
    select * into strict lifecycle_cfg from public.account_lifecycle_config where singleton_id = 1;
    normalized_username := lower(trim(coalesce(new.raw_user_meta_data ->> 'username', '')));
    if normalized_username !~ '^[a-z0-9_]{3,24}$' then
        raise exception 'username must match ^[a-z0-9_]{3,24}$';
    end if;

    acceptance_source := lower(trim(coalesce(new.raw_user_meta_data ->> 'terms_acceptance_source', '')));
    archive_contract_complete :=
        coalesce(new.raw_user_meta_data ->> 'terms_accepted', 'false') = 'true'
        and coalesce(new.raw_user_meta_data ->> 'privacy_accepted', 'false') = 'true';
    legacy_research_consent :=
        coalesce(new.raw_user_meta_data ->> 'raw_gpx_research_consent', 'false') = 'true';
    prepared_contract_complete :=
        coalesce(new.raw_user_meta_data ->> 'terms_accepted', 'false') = 'true'
        and coalesce(new.raw_user_meta_data ->> 'privacy_acknowledged', 'false') = 'true'
        and acceptance_source in ('mobile', 'web');

    if not lifecycle_cfg.lifecycle_enabled then
        if archive_contract_complete then
            insert into public.user_profiles (
                user_id, username, terms_accepted_at, terms_version,
                privacy_accepted_at, privacy_version,
                raw_gpx_research_consent, raw_gpx_research_consent_at,
                raw_gpx_research_consent_version, raw_gpx_research_consent_withdrawn_at,
                privacy_acknowledged_at, terms_acceptance_source
            ) values (
                new.id, normalized_username, accepted_at, archive_cfg.terms_version,
                accepted_at, archive_cfg.privacy_version,
                legacy_research_consent, accepted_at,
                case when legacy_research_consent
                    then archive_cfg.research_consent_version
                    else 'legacy-disabled'
                end,
                case when legacy_research_consent then null else accepted_at end,
                accepted_at, 'legacy_signup'
            );
            return new;
        end if;

        if not prepared_contract_complete then
            raise exception 'signup contract is incomplete';
        end if;

        -- M1 defaults deliberately keep this account restricted until the
        -- coordinated lifecycle cutover. With the switch off, archive access
        -- remains backward-compatible and no lifecycle notice is created.
        insert into public.user_profiles (
            user_id, username, terms_accepted_at, terms_version,
            privacy_accepted_at, privacy_version,
            raw_gpx_research_consent, raw_gpx_research_consent_at,
            raw_gpx_research_consent_version, raw_gpx_research_consent_withdrawn_at,
            privacy_acknowledged_at, terms_acceptance_source
        ) values (
            new.id, normalized_username, accepted_at, archive_cfg.terms_version,
            accepted_at, archive_cfg.privacy_version,
            false, accepted_at, 'legacy-disabled', accepted_at,
            accepted_at, acceptance_source
        );
        return new;
    end if;

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

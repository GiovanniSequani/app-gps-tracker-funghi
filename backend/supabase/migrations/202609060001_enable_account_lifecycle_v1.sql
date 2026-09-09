-- Controlled production cutover for the effective legal documents published
-- on 2026-09-06. This enables ONLY the contributor-account lifecycle.
-- Account export/deletion rights remain explicitly disabled.
--
-- Safe to rerun: an already enabled exact 1.0/1.0 configuration is accepted;
-- every partial or unexpected state aborts the transaction.

begin;

do $$
declare
    cfg public.account_lifecycle_config%rowtype;
begin
    select * into strict cfg
      from public.account_lifecycle_config
     where singleton_id = 1
     for update;

    if cfg.lifecycle_enabled then
        if cfg.current_terms_version = '1.0'
           and cfg.current_privacy_version = '1.0'
           and not cfg.account_rights_enabled then
            return;
        end if;
        raise exception 'lifecycle is already enabled with an unexpected configuration';
    end if;

    if cfg.account_rights_enabled then
        raise exception 'account rights must remain disabled during lifecycle cutover';
    end if;
    if cfg.current_terms_version is not null
       and cfg.current_terms_version <> '1.0' then
        raise exception 'unexpected pre-cutover terms version';
    end if;
    if cfg.current_privacy_version is not null
       and cfg.current_privacy_version <> '1.0' then
        raise exception 'unexpected pre-cutover privacy version';
    end if;
    if not exists (
        select 1 from pg_trigger
         where tgname = 'enforce_contributor_track_mutation' and not tgisinternal
    ) or not exists (
        select 1 from pg_trigger
         where tgname = 'enforce_contributor_marker_mutation' and not tgisinternal
    ) then
        raise exception 'lifecycle archive gates are incomplete';
    end if;
    if exists (
        select 1 from public.user_profiles
         where legal_notice_first_seen_at is not null
            or legal_reaccept_deadline_at is not null
    ) then
        raise exception 'pre-cutover legal notice timing is not empty';
    end if;
    if exists (
        select 1 from public.user_profiles
         where account_state = 'active'
           and (restriction_reason is not null or restricted_at is not null)
    ) then
        raise exception 'invalid active profile exists';
    end if;

    update public.account_lifecycle_config
       set current_terms_version = '1.0',
           current_privacy_version = '1.0',
           lifecycle_enabled = true,
           account_rights_enabled = false,
           updated_at = now()
     where singleton_id = 1;

    if not found then
        raise exception 'lifecycle configuration row is missing';
    end if;
end
$$;

-- These result sets are the immediate operator evidence in the SQL Editor.
select public.get_account_lifecycle_public_config() as lifecycle_public_config;
select public.account_lifecycle_setup_audit() as lifecycle_setup_audit;
select public.account_rights_setup_audit() as account_rights_setup_audit;

commit;

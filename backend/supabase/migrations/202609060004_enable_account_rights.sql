-- Controlled production cutover for account export and verified deletion.
-- Prerequisites: lifecycle 1.0/1.0 is active and all account-rights migrations
-- through 202609060003 have already been applied.

begin;

do $$
declare
    cfg public.account_lifecycle_config%rowtype;
begin
    select * into strict cfg
      from public.account_lifecycle_config
     where singleton_id = 1
     for update;

    if not cfg.lifecycle_enabled then
        raise exception 'account lifecycle must remain enabled before rights cutover';
    end if;
    if cfg.current_terms_version is distinct from '1.0'
       or cfg.current_privacy_version is distinct from '1.0' then
        raise exception 'unexpected effective legal document versions';
    end if;
    if not exists (
        select 1 from storage.buckets
         where id = 'user-data-exports' and public = false
    ) then
        raise exception 'private export bucket is missing';
    end if;
    if to_regprocedure('public.request_my_data_export()') is null
       or to_regprocedure('public.request_my_account_deletion_verification()') is null
       or to_regprocedure('public.request_external_account_deletion(text)') is null
       or to_regprocedure('public.confirm_account_deletion(text)') is null
       or to_regprocedure('public.prepare_account_rights_daily(timestamptz)') is null then
        raise exception 'account rights RPC contract is incomplete';
    end if;
    if not has_function_privilege('authenticated', 'public.request_my_data_export()', 'EXECUTE')
       or not has_function_privilege('authenticated', 'public.request_my_account_deletion_verification()', 'EXECUTE')
       or not has_function_privilege('anon', 'public.request_external_account_deletion(text)', 'EXECUTE')
       or not has_function_privilege('anon', 'public.confirm_account_deletion(text)', 'EXECUTE') then
        raise exception 'account rights client grants are incomplete';
    end if;
    if has_function_privilege('anon', 'public.prepare_account_rights_daily(timestamptz)', 'EXECUTE')
       or has_function_privilege('authenticated', 'public.prepare_account_rights_daily(timestamptz)', 'EXECUTE') then
        raise exception 'account rights worker RPC is exposed to clients';
    end if;

    update public.account_lifecycle_config
       set account_rights_enabled = true,
           updated_at = now()
     where singleton_id = 1;
end
$$;

select public.account_rights_setup_audit() as account_rights,
       jsonb_build_object(
           'lifecycle_enabled', lifecycle_enabled,
           'terms_version', current_terms_version,
           'privacy_version', current_privacy_version,
           'account_rights_enabled', account_rights_enabled
       ) as preserved_lifecycle
  from public.account_lifecycle_config
 where singleton_id = 1;

commit;

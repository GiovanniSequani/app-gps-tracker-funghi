-- Restore the token-authenticated public deletion callback contract.
-- This migration does not enable account rights and does not change lifecycle.

begin;

-- The one-time token is the bearer credential. The SECURITY DEFINER function
-- validates its SHA-256 digest, expiry and single-use state; clients retain no
-- direct access to the underlying request or job tables.
revoke all on function public.confirm_account_deletion(text) from public;
grant execute on function public.confirm_account_deletion(text) to anon, authenticated, service_role;

do $$
begin
    if not has_function_privilege(
        'anon', 'public.confirm_account_deletion(text)', 'EXECUTE'
    ) then
        raise exception 'anonymous deletion callback grant is missing';
    end if;
    if has_table_privilege(
        'anon', 'public.account_external_deletion_requests', 'SELECT'
    ) or has_table_privilege(
        'anon', 'public.account_deletion_jobs', 'SELECT'
    ) then
        raise exception 'account deletion internals are exposed to anonymous clients';
    end if;
end
$$;

select public.account_rights_setup_audit() as account_rights,
       jsonb_build_object(
           'lifecycle_enabled', lifecycle_enabled,
           'account_rights_enabled', account_rights_enabled
       ) as unchanged_switches
  from public.account_lifecycle_config
 where singleton_id = 1;

commit;

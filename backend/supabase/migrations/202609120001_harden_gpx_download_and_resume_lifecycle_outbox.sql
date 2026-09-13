-- AND-REL-001 follow-up.
--
-- 1. GPX bytes may only be fetched through the authenticated Storage route.
--    In particular, authenticated clients cannot mint bearer signed URLs that
--    would remain usable after the account becomes restricted.
-- 2. A completed lifecycle run may be resumed on the same UTC day when a new
--    transactional email (for example deletion verification) becomes due.
--    Counters are deliberately preserved, so the configured daily limit still
--    applies across every invocation for that date.

begin;

do $$
begin
    if to_regprocedure('storage.allow_only_operation(text)') is null then
        raise exception 'storage.allow_only_operation(text) is required';
    end if;
end;
$$;

drop policy if exists user_gpx_objects_select_own on storage.objects;
create policy user_gpx_objects_select_own
    on storage.objects for select to authenticated
    using (
        bucket_id = 'user-gpx'
        and storage.allow_only_operation('object.get_authenticated')
        and owner_id = (select auth.uid()::text)
        and (storage.foldername(name))[1] = (select auth.uid()::text)
        and (select public.has_my_current_contributor_access())
        and exists (
            select 1
              from public.user_gpx_tracks track
             where track.user_id = (select auth.uid())
               and track.storage_path = name
        )
    );

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
declare
    cfg public.account_lifecycle_config%rowtype;
    run_row public.account_lifecycle_job_runs%rowtype;
    dispatchable boolean;
begin
    if p_lease_seconds not between 60 and 86400 then
        raise exception 'invalid lease';
    end if;

    select * into strict cfg
      from public.account_lifecycle_config
     where singleton_id = 1;

    if exists (
        select 1
          from public.account_lifecycle_job_runs
         where status = 'running'
           and lease_until > now()
           and owner_token is distinct from p_owner_token
    ) then
        return jsonb_build_object('claimed', false, 'reason', 'locked');
    end if;

    insert into public.account_lifecycle_job_runs (run_date)
    values (p_run_date)
    on conflict (run_date) do nothing;

    select * into strict run_row
      from public.account_lifecycle_job_runs
     where run_date = p_run_date
     for update;

    if run_row.status = 'completed' then
        select exists (
            select 1
              from public.account_email_outbox outbox
             where outbox.status in ('pending', 'retry')
               and outbox.available_at <= now()
               and outbox.attempt_count < cfg.dispatcher_max_attempts
        ) into dispatchable;

        if not dispatchable
           or run_row.attempted_count >= cfg.dispatcher_daily_limit then
            return jsonb_build_object('claimed', false, 'reason', 'completed');
        end if;
    end if;

    if run_row.status = 'running'
       and run_row.lease_until > now()
       and run_row.owner_token is distinct from p_owner_token then
        return jsonb_build_object('claimed', false, 'reason', 'locked');
    end if;

    update public.account_lifecycle_job_runs
       set status = 'running',
           owner_token = p_owner_token,
           lease_until = now() + make_interval(secs => p_lease_seconds),
           started_at = coalesce(started_at, now()),
           completed_at = null,
           updated_at = now()
     where run_date = p_run_date
     returning * into run_row;

    return jsonb_build_object(
        'claimed', true,
        'attempted_count', run_row.attempted_count,
        'sent_count', run_row.sent_count
    );
end;
$$;

revoke all on function public.claim_account_lifecycle_daily_run(date, uuid, integer)
    from public, anon, authenticated;
grant execute on function public.claim_account_lifecycle_daily_run(date, uuid, integer)
    to service_role;

do $$
begin
    if not pg_catalog.has_function_privilege(
        'service_role',
        'public.claim_account_lifecycle_daily_run(date,uuid,integer)',
        'EXECUTE'
    ) then
        raise exception 'service_role must execute lifecycle run claim';
    end if;

    if pg_catalog.has_function_privilege(
        'authenticated',
        'public.claim_account_lifecycle_daily_run(date,uuid,integer)',
        'EXECUTE'
    ) then
        raise exception 'authenticated must not execute lifecycle run claim';
    end if;
end;
$$;

commit;

-- BE-EMAIL-004: enqueue one transactional notification when an export becomes ready.
-- Depends on 202608310001_account_lifecycle_and_email_outbox.sql and
-- 202609010001_account_rights_export_deletion.sql.
-- Idempotent and intentionally leaves lifecycle/account-rights switches unchanged.

begin;

alter table public.account_email_outbox
    drop constraint if exists account_email_outbox_event_type_check;

alter table public.account_email_outbox
    add constraint account_email_outbox_event_type_check check (event_type in (
        'terms_started', 'terms_six_months', 'terms_30_days', 'terms_7_days', 'terms_expired',
        'inactive_started', 'inactive_six_months', 'inactive_30_days', 'inactive_7_days', 'inactive_expired',
        'external_deletion_verify', 'export_ready'
    ));

create or replace function public.complete_account_export(
    p_job_id uuid,
    p_claim_token uuid,
    p_size_bytes bigint,
    p_sha256 text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    cfg public.account_lifecycle_config%rowtype;
    completed_job public.account_export_jobs%rowtype;
begin
    select * into strict cfg
      from public.account_lifecycle_config
     where singleton_id = 1;

    update public.account_export_jobs
       set status = 'ready',
           ready_at = now(),
           expires_at = now() + make_interval(hours => cfg.export_ttl_hours),
           size_bytes = p_size_bytes,
           content_sha256 = lower(p_sha256),
           claim_token = null,
           claimed_at = null,
           last_error_code = null,
           updated_at = now()
     where id = p_job_id
       and status = 'building'
       and claim_token = p_claim_token
    returning * into completed_job;

    if not found then
        raise exception 'export claim is no longer valid';
    end if;

    perform public.enqueue_account_email(
        completed_job.user_id,
        'export_ready',
        completed_job.user_id::text || ':export-ready:' || completed_job.id::text,
        jsonb_build_object(
            'export_id', completed_job.id,
            'expires_at', completed_job.expires_at
        )
    );
end;
$$;

revoke all on function public.complete_account_export(uuid, uuid, bigint, text)
    from public, anon, authenticated;
grant execute on function public.complete_account_export(uuid, uuid, bigint, text)
    to service_role;

comment on function public.complete_account_export(uuid, uuid, bigint, text) is
    'Atomically marks a private export ready and enqueues one deduplicated export_ready notification.';

commit;

select jsonb_build_object(
    'lifecycle_enabled', lifecycle_enabled,
    'account_rights_enabled', account_rights_enabled,
    'export_ready_event_allowed', exists (
        select 1
          from pg_constraint
         where conrelid = 'public.account_email_outbox'::regclass
           and conname = 'account_email_outbox_event_type_check'
           and pg_get_constraintdef(oid) like '%export_ready%'
    )
) as export_ready_email_setup
from public.account_lifecycle_config
where singleton_id = 1;

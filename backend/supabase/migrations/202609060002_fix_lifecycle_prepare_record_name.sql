-- Fix prepare_account_lifecycle_daily after lifecycle cutover.
--
-- The original body used `profile` both as an unassigned PL/pgSQL record and
-- as a SQL table alias.  With lifecycle enabled, PL/pgSQL resolved the alias
-- as the record and aborted before the dispatcher could claim an email.

begin;

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

commit;

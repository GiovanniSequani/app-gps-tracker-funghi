-- Fix pgcrypto lookup in account-rights SECURITY DEFINER functions already
-- installed by 202609010001. Supabase installs pgcrypto in `extensions`, while
-- these functions intentionally use an empty search_path.
--
-- Token creation is also moved after the feature gate so the public external
-- endpoint keeps returning its non-enumerating accepted response while account
-- rights are disabled.

create or replace function public.request_external_account_deletion(p_email text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    cfg public.account_lifecycle_config%rowtype;
    normalized_email text := lower(trim(coalesce(p_email, '')));
    hashed_email text;
    rate_key bytea;
    target_user uuid;
    raw_token text;
    request_id uuid;
begin
    select * into strict cfg from public.account_lifecycle_config where singleton_id = 1;
    if normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' then
        return jsonb_build_object('accepted', true);
    end if;
    if not cfg.account_rights_enabled then return jsonb_build_object('accepted', true); end if;
    raw_token := encode(extensions.gen_random_bytes(32), 'hex');
    request_id := gen_random_uuid();
    select email_rate_hmac_key into strict rate_key from public.account_rights_secrets where singleton_id = 1;
    hashed_email := encode(extensions.hmac(convert_to(normalized_email, 'UTF8'), rate_key, 'sha256'), 'hex');
    perform pg_advisory_xact_lock(hashtext('external_deletion_global_rate'));
    perform pg_advisory_xact_lock(hashtext(hashed_email));
    if (select count(*) from public.account_external_deletion_requests where created_at >= now() - interval '1 hour') >= cfg.external_global_hourly_limit
       or (select count(*) from public.account_external_deletion_requests where email_hash = hashed_email and created_at >= now() - interval '1 hour') >= cfg.external_request_hourly_limit then
        return jsonb_build_object('accepted', true);
    end if;
    select id into target_user from auth.users where lower(email) = normalized_email;
    insert into public.account_external_deletion_requests (
        id, user_id, email_hash, token_digest, source, expires_at
    ) values (
        request_id, target_user, hashed_email, encode(extensions.digest(raw_token, 'sha256'), 'hex'),
        case when target_user is null then 'unknown_email' else 'external' end,
        now() + make_interval(mins => cfg.deletion_token_ttl_minutes)
    );
    if target_user is not null then
        perform public.enqueue_account_email(
            target_user, 'external_deletion_verify',
            target_user::text || ':external-deletion:' || request_id::text,
            jsonb_build_object('verification_token', raw_token, 'request_id', request_id)
        );
    end if;
    return jsonb_build_object('accepted', true);
end;
$$;

create or replace function public.request_my_account_deletion_verification()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    caller_id uuid := auth.uid();
    cfg public.account_lifecycle_config%rowtype;
    account_email text;
    raw_token text;
    request_id uuid;
    hashed_email text;
    rate_key bytea;
begin
    if caller_id is null then raise exception 'authentication required'; end if;
    select * into strict cfg from public.account_lifecycle_config where singleton_id = 1;
    if not cfg.account_rights_enabled then raise exception 'account rights are not enabled'; end if;
    raw_token := encode(extensions.gen_random_bytes(32), 'hex');
    request_id := gen_random_uuid();
    select lower(email) into strict account_email from auth.users where id = caller_id;
    select email_rate_hmac_key into strict rate_key from public.account_rights_secrets where singleton_id = 1;
    hashed_email := encode(extensions.hmac(convert_to(account_email, 'UTF8'), rate_key, 'sha256'), 'hex');
    perform pg_advisory_xact_lock(hashtext(hashed_email));
    if (select count(*) from public.account_external_deletion_requests where email_hash = hashed_email and created_at >= now() - interval '1 hour') >= cfg.external_request_hourly_limit then
        raise exception 'deletion verification rate limit exceeded';
    end if;
    insert into public.account_external_deletion_requests (
        id, user_id, email_hash, token_digest, source, expires_at
    ) values (
        request_id, caller_id, hashed_email, encode(extensions.digest(raw_token, 'sha256'), 'hex'),
        'authenticated', now() + make_interval(mins => cfg.deletion_token_ttl_minutes)
    );
    perform public.enqueue_account_email(
        caller_id, 'external_deletion_verify',
        caller_id::text || ':account-deletion:' || request_id::text,
        jsonb_build_object('verification_token', raw_token, 'request_id', request_id)
    );
    return jsonb_build_object('accepted', true, 'expires_in_minutes', cfg.deletion_token_ttl_minutes);
end;
$$;

create or replace function public.confirm_account_deletion(p_verification_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    token_hash text := encode(extensions.digest(coalesce(p_verification_token, ''), 'sha256'), 'hex');
    request_row public.account_external_deletion_requests%rowtype;
    job_id uuid;
begin
    select * into request_row from public.account_external_deletion_requests
     where token_digest = token_hash and consumed_at is null and expires_at > now()
     for update;
    if not found or request_row.user_id is null then raise exception 'verification token is invalid or expired'; end if;
    perform pg_advisory_xact_lock(hashtext(request_row.user_id::text));
    update public.account_external_deletion_requests set consumed_at = now()
     where user_id = request_row.user_id and consumed_at is null;
    update public.user_profiles set account_state = 'deletion_pending', deletion_requested_at = now()
     where user_id = request_row.user_id;
    update public.account_email_outbox set status = 'cancelled', last_error_code = 'account_deletion_requested', updated_at = now()
     where user_id = request_row.user_id and status in ('pending', 'retry');
    select id into job_id from public.account_deletion_jobs
     where user_id = request_row.user_id and status <> 'completed' order by requested_at limit 1;
    if job_id is null then
        insert into public.account_deletion_jobs(user_id, source)
        values (request_row.user_id, case when request_row.source = 'authenticated' then 'authenticated' else 'external' end)
        returning id into job_id;
    end if;
    return jsonb_build_object('confirmed', true, 'job_id', job_id);
end;
$$;

revoke all on function public.request_external_account_deletion(text) from public;
grant execute on function public.request_external_account_deletion(text) to anon, authenticated, service_role;
revoke all on function public.request_my_account_deletion_verification() from public, anon;
grant execute on function public.request_my_account_deletion_verification() to authenticated;
-- The verification token is the bearer credential used by the public HTTPS
-- callback. The function validates its hash, expiry and single-use state, so
-- clients need EXECUTE but never direct table access.
revoke all on function public.confirm_account_deletion(text) from public;
grant execute on function public.confirm_account_deletion(text) to anon, authenticated, service_role;

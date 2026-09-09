-- Account export, verified deletion, resumable cleanup and email retention.
-- Depends on 202608290001 and 202608310001.
-- Safe by default: account_rights_enabled remains false until coordinated cutover.

alter table public.account_lifecycle_config
    add column if not exists account_rights_enabled boolean not null default false,
    add column if not exists export_ttl_hours integer not null default 24,
    add column if not exists export_rate_limit_hours integer not null default 24,
    add column if not exists deletion_token_ttl_minutes integer not null default 2880,
    add column if not exists external_request_hourly_limit integer not null default 3,
    add column if not exists external_global_hourly_limit integer not null default 100;

do $$
begin
    if not exists (select 1 from pg_constraint where conrelid = 'public.account_lifecycle_config'::regclass and conname = 'account_rights_config_valid') then
        alter table public.account_lifecycle_config add constraint account_rights_config_valid check (
            export_ttl_hours between 1 and 168
            and export_rate_limit_hours between 1 and 168
            and deletion_token_ttl_minutes between 60 and 10080
            and external_request_hourly_limit between 1 and 20
            and external_global_hourly_limit between 10 and 10000
        );
    end if;
end
$$;

create table if not exists public.account_rights_secrets (
    singleton_id smallint primary key default 1 check (singleton_id = 1),
    email_rate_hmac_key bytea not null check (octet_length(email_rate_hmac_key) = 32),
    created_at timestamptz not null default now()
);

insert into public.account_rights_secrets(singleton_id, email_rate_hmac_key)
values (1, extensions.gen_random_bytes(32))
on conflict (singleton_id) do nothing;

create table if not exists public.account_export_jobs (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    status text not null default 'pending' check (status in ('pending', 'building', 'retry', 'ready', 'expired', 'cleaning')),
    storage_path text not null unique,
    requested_at timestamptz not null default now(),
    available_at timestamptz not null default now(),
    ready_at timestamptz,
    expires_at timestamptz,
    size_bytes bigint,
    content_sha256 text,
    attempt_count integer not null default 0,
    claim_token uuid,
    claimed_at timestamptz,
    last_error_code text,
    updated_at timestamptz not null default now(),
    constraint account_export_storage_path check (storage_path = user_id::text || '/' || id::text || '.zip'),
    constraint account_export_hash check (content_sha256 is null or content_sha256 ~ '^[0-9a-f]{64}$'),
    constraint account_export_ready check (
        (status = 'ready' and ready_at is not null and expires_at > ready_at and size_bytes > 0 and content_sha256 is not null)
        or status <> 'ready'
    ),
    constraint account_export_claim check (
        (status in ('building', 'cleaning') and claim_token is not null and claimed_at is not null)
        or (status not in ('building', 'cleaning') and claim_token is null and claimed_at is null)
    )
);

create index if not exists account_export_jobs_dispatch_idx on public.account_export_jobs(status, available_at, requested_at);
create index if not exists account_export_jobs_user_idx on public.account_export_jobs(user_id, requested_at desc);

create table if not exists public.account_external_deletion_requests (
    id uuid primary key default gen_random_uuid(),
    user_id uuid references auth.users(id) on delete cascade,
    email_hash text not null check (email_hash ~ '^[0-9a-f]{64}$'),
    token_digest text not null check (token_digest ~ '^[0-9a-f]{64}$'),
    source text not null check (source in ('authenticated', 'external', 'unknown_email')),
    expires_at timestamptz not null,
    consumed_at timestamptz,
    created_at timestamptz not null default now(),
    constraint account_external_deletion_expiry check (expires_at > created_at)
);

create index if not exists account_external_deletion_rate_idx on public.account_external_deletion_requests(email_hash, created_at desc);
create unique index if not exists account_external_deletion_token_idx on public.account_external_deletion_requests(token_digest);

create table if not exists public.account_deletion_jobs (
    id uuid primary key default gen_random_uuid(),
    user_id uuid references auth.users(id) on delete set null,
    source text not null check (source in ('authenticated', 'external', 'terms_expired', 'inactive_expired', 'admin')),
    status text not null default 'pending' check (status in ('pending', 'processing', 'retry', 'completed')),
    stage text not null default 'email_cleanup' check (stage in ('email_cleanup', 'storage_cleanup', 'database_cleanup', 'auth_cleanup', 'completed')),
    requested_at timestamptz not null default now(),
    available_at timestamptz not null default now(),
    attempt_count integer not null default 0,
    claim_token uuid,
    claimed_at timestamptz,
    email_cleanup_completed_at timestamptz,
    completed_at timestamptz,
    last_error_code text,
    updated_at timestamptz not null default now(),
    constraint account_deletion_claim check (
        (status = 'processing' and claim_token is not null and claimed_at is not null)
        or (status <> 'processing' and claim_token is null and claimed_at is null)
    )
);

create unique index if not exists account_deletion_jobs_open_user_idx
    on public.account_deletion_jobs(user_id) where user_id is not null and status <> 'completed';
create index if not exists account_deletion_jobs_dispatch_idx on public.account_deletion_jobs(status, available_at, requested_at);

alter table public.account_email_outbox
    add column if not exists gmail_cleaned_at timestamptz;

alter table public.account_export_jobs enable row level security;
alter table public.account_external_deletion_requests enable row level security;
alter table public.account_deletion_jobs enable row level security;
alter table public.account_rights_secrets enable row level security;

drop policy if exists account_export_jobs_read_own on public.account_export_jobs;
create policy account_export_jobs_read_own on public.account_export_jobs
    for select to authenticated using ((select auth.uid()) = user_id);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('user-data-exports', 'user-data-exports', false, 629145600, array['application/zip'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists user_data_exports_select_own on storage.objects;
create policy user_data_exports_select_own on storage.objects
    for select to authenticated using (
        bucket_id = 'user-data-exports'
        and (storage.foldername(name))[1] = (select auth.uid()::text)
        and exists (
            select 1 from public.account_export_jobs job
             where job.user_id = (select auth.uid()) and job.storage_path = name
               and job.status = 'ready' and job.expires_at > now()
        )
    );

-- Generic response intentionally prevents account/email enumeration.
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

create or replace function public.request_my_data_export()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    caller_id uuid := auth.uid();
    cfg public.account_lifecycle_config%rowtype;
    existing public.account_export_jobs%rowtype;
    new_id uuid := gen_random_uuid();
begin
    if caller_id is null then raise exception 'authentication required'; end if;
    perform pg_advisory_xact_lock(hashtext(caller_id::text));
    select * into strict cfg from public.account_lifecycle_config where singleton_id = 1;
    if not cfg.account_rights_enabled then raise exception 'account rights are not enabled'; end if;
    if exists (select 1 from public.user_profiles where user_id = caller_id and account_state = 'deletion_pending') then
        raise exception 'export must be requested before deletion is confirmed';
    end if;
    select * into existing from public.account_export_jobs
     where user_id = caller_id and status in ('pending', 'building', 'retry', 'ready')
       and (status <> 'ready' or expires_at > now()) order by requested_at desc limit 1;
    if found then return to_jsonb(existing); end if;
    if exists (select 1 from public.account_export_jobs where user_id = caller_id and requested_at > now() - make_interval(hours => cfg.export_rate_limit_hours)) then
        raise exception 'data export rate limit exceeded';
    end if;
    insert into public.account_export_jobs(id, user_id, storage_path)
    values (new_id, caller_id, caller_id::text || '/' || new_id::text || '.zip') returning * into existing;
    return to_jsonb(existing);
end;
$$;

create or replace function public.prepare_account_rights_daily(p_now timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare cfg public.account_lifecycle_config%rowtype; deletion_count integer := 0; expired_count integer := 0;
begin
    select * into strict cfg from public.account_lifecycle_config where singleton_id = 1;
    if not cfg.account_rights_enabled then return jsonb_build_object('enabled', false); end if;
    update public.account_export_jobs set status = 'retry', claim_token = null, claimed_at = null, available_at = p_now, last_error_code = 'claim_timeout'
     where status = 'building' and claimed_at < p_now - interval '30 minutes';
    update public.account_export_jobs set status = 'expired', claim_token = null, claimed_at = null, available_at = p_now, last_error_code = 'cleanup_claim_timeout'
     where status = 'cleaning' and claimed_at < p_now - interval '30 minutes';
    update public.account_export_jobs set status = 'expired', claim_token = null, claimed_at = null, updated_at = p_now
     where status = 'ready' and expires_at <= p_now;
    get diagnostics expired_count = row_count;
    update public.account_deletion_jobs set status = 'retry', claim_token = null, claimed_at = null, available_at = p_now, last_error_code = 'claim_timeout'
     where status = 'processing' and claimed_at < p_now - interval '30 minutes';
    update public.account_email_outbox outbox
       set status = 'cancelled', payload = payload - 'verification_token',
           last_error_code = 'verification_expired', updated_at = p_now
     where outbox.event_type = 'external_deletion_verify'
       and outbox.status in ('pending', 'retry')
       and not exists (
           select 1 from public.account_external_deletion_requests request
            where request.id::text = outbox.payload ->> 'request_id'
              and request.consumed_at is null and request.expires_at > p_now
       );
    insert into public.account_deletion_jobs(user_id, source)
    select profile.user_id,
           case when profile.restriction_reason = 'inactive' then 'inactive_expired' else 'terms_expired' end
      from public.user_profiles profile
     where profile.account_state = 'deletion_pending'
       and not exists (select 1 from public.account_deletion_jobs job where job.user_id = profile.user_id and job.status <> 'completed')
    on conflict do nothing;
    get diagnostics deletion_count = row_count;
    delete from public.account_external_deletion_requests where created_at < p_now - interval '30 days';
    return jsonb_build_object('enabled', true, 'deletion_jobs_created', deletion_count, 'exports_expired', expired_count);
end;
$$;

create or replace function public.claim_next_account_export(p_owner_token uuid, p_lease_seconds integer default 1800)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare job public.account_export_jobs%rowtype; account_email text; auth_metadata jsonb;
begin
    select * into job from public.account_export_jobs
     where status in ('pending', 'retry') and available_at <= now() and attempt_count < 5
     order by requested_at for update skip locked limit 1;
    if not found then return jsonb_build_object('claimed', false); end if;
    update public.account_export_jobs set status = 'building', claim_token = p_owner_token, claimed_at = now(),
        attempt_count = attempt_count + 1, updated_at = now() where id = job.id returning * into job;
    select email, jsonb_build_object(
        'email', email, 'created_at', created_at,
        'email_confirmed_at', email_confirmed_at, 'last_sign_in_at', last_sign_in_at
    ) into account_email, auth_metadata from auth.users where id = job.user_id;
    return jsonb_build_object('claimed', true, 'id', job.id, 'user_id', job.user_id,
        'storage_path', job.storage_path, 'email', account_email,
        'auth_metadata', auth_metadata, 'claim_token', p_owner_token);
end;
$$;

create or replace function public.complete_account_export(p_job_id uuid, p_claim_token uuid, p_size_bytes bigint, p_sha256 text)
returns void language plpgsql security definer set search_path = '' as $$
declare cfg public.account_lifecycle_config%rowtype;
begin
    select * into strict cfg from public.account_lifecycle_config where singleton_id = 1;
    update public.account_export_jobs set status = 'ready', ready_at = now(),
        expires_at = now() + make_interval(hours => cfg.export_ttl_hours), size_bytes = p_size_bytes,
        content_sha256 = lower(p_sha256), claim_token = null, claimed_at = null, last_error_code = null, updated_at = now()
     where id = p_job_id and status = 'building' and claim_token = p_claim_token;
    if not found then raise exception 'export claim is no longer valid'; end if;
end;
$$;

create or replace function public.fail_account_export(p_job_id uuid, p_claim_token uuid, p_error_code text)
returns void language plpgsql security definer set search_path = '' as $$
begin
    update public.account_export_jobs set status = 'retry', available_at = now() + make_interval(secs => least(86400, 300 * power(2, greatest(0, attempt_count - 1))::integer)),
        claim_token = null, claimed_at = null, last_error_code = left(coalesce(p_error_code, 'export_error'), 80), updated_at = now()
     where id = p_job_id and status = 'building' and claim_token = p_claim_token;
end;
$$;

create or replace function public.claim_expired_account_export(p_owner_token uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare job public.account_export_jobs%rowtype;
begin
    select * into job from public.account_export_jobs where status = 'expired' order by expires_at for update skip locked limit 1;
    if not found then return jsonb_build_object('claimed', false); end if;
    update public.account_export_jobs set status = 'cleaning', claim_token = p_owner_token, claimed_at = now(), updated_at = now()
     where id = job.id returning * into job;
    return jsonb_build_object('claimed', true, 'id', job.id, 'storage_path', job.storage_path, 'claim_token', p_owner_token);
end;
$$;

create or replace function public.complete_expired_account_export(p_job_id uuid, p_claim_token uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
    delete from public.account_export_jobs where id = p_job_id and status = 'cleaning' and claim_token = p_claim_token;
    if not found then raise exception 'export cleanup claim is no longer valid'; end if;
end;
$$;

create or replace function public.claim_next_account_deletion(p_claim_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare job public.account_deletion_jobs%rowtype; account_email text; paths jsonb; message_ids jsonb;
begin
    select * into job from public.account_deletion_jobs
     where status in ('pending', 'retry') and available_at <= now() and attempt_count < 100
     order by requested_at for update skip locked limit 1;
    if not found then return jsonb_build_object('claimed', false); end if;
    update public.account_deletion_jobs set status = 'processing', claim_token = p_claim_token, claimed_at = now(),
        attempt_count = attempt_count + 1, updated_at = now() where id = job.id returning * into job;
    select email into account_email from auth.users where id = job.user_id;
    select coalesce(jsonb_agg(jsonb_build_object('bucket', bucket_id, 'path', name)), '[]'::jsonb) into paths
      from storage.objects where bucket_id in ('user-gpx', 'user-data-exports')
       and (storage.foldername(name))[1] = job.user_id::text;
    select coalesce(jsonb_agg(id order by id), '[]'::jsonb) into message_ids
      from public.account_email_outbox where user_id = job.user_id and status = 'sent' and gmail_cleaned_at is null;
    return jsonb_build_object('claimed', true, 'id', job.id, 'user_id', job.user_id, 'stage', job.stage,
        'claim_token', p_claim_token, 'email', account_email, 'storage_objects', paths, 'lifecycle_message_ids', message_ids);
end;
$$;

create or replace function public.mark_deletion_email_cleanup_complete(p_job_id uuid, p_claim_token uuid, p_message_ids bigint[])
returns void language plpgsql security definer set search_path = '' as $$
begin
    update public.account_email_outbox set gmail_cleaned_at = now()
     where id = any(coalesce(p_message_ids, array[]::bigint[]));
    update public.account_deletion_jobs set email_cleanup_completed_at = now(), stage = 'storage_cleanup', updated_at = now()
     where id = p_job_id and status = 'processing' and claim_token = p_claim_token and stage = 'email_cleanup';
    if not found then raise exception 'deletion claim is no longer valid'; end if;
end;
$$;

create or replace function public.advance_account_deletion(p_job_id uuid, p_claim_token uuid, p_completed_stage text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare job public.account_deletion_jobs%rowtype; remaining integer;
begin
    select * into strict job from public.account_deletion_jobs where id = p_job_id and status = 'processing' and claim_token = p_claim_token for update;
    if p_completed_stage = 'storage_cleanup' and job.stage = 'storage_cleanup' then
        select count(*) into remaining from storage.objects where bucket_id in ('user-gpx', 'user-data-exports')
          and (storage.foldername(name))[1] = job.user_id::text;
        if remaining <> 0 then raise exception 'account Storage cleanup is incomplete'; end if;
        update public.account_deletion_jobs set stage = 'database_cleanup', updated_at = now() where id = job.id;
    elsif p_completed_stage = 'database_cleanup' and job.stage = 'database_cleanup' then
        if job.email_cleanup_completed_at is null then raise exception 'email cleanup is incomplete'; end if;
        delete from public.account_email_outbox where user_id = job.user_id;
        delete from public.account_external_deletion_requests where user_id = job.user_id;
        delete from public.account_export_jobs where user_id = job.user_id;
        delete from public.user_profiles where user_id = job.user_id;
        update public.account_deletion_jobs set stage = 'auth_cleanup', updated_at = now() where id = job.id;
    elsif p_completed_stage = 'auth_cleanup' and job.stage = 'auth_cleanup' then
        update public.account_deletion_jobs set stage = 'completed', status = 'completed', completed_at = now(),
            claim_token = null, claimed_at = null, last_error_code = null, updated_at = now() where id = job.id;
    else
        raise exception 'invalid deletion stage transition';
    end if;
end;
$$;

create or replace function public.fail_account_deletion(p_job_id uuid, p_claim_token uuid, p_error_code text)
returns void language plpgsql security definer set search_path = '' as $$
begin
    update public.account_deletion_jobs set status = 'retry', available_at = now() + make_interval(secs => least(86400, 300 * power(2, greatest(0, attempt_count - 1))::integer)),
        claim_token = null, claimed_at = null, last_error_code = left(coalesce(p_error_code, 'deletion_error'), 80), updated_at = now()
     where id = p_job_id and status = 'processing' and claim_token = p_claim_token;
end;
$$;

create or replace function public.list_due_lifecycle_email_cleanup(p_before timestamptz, p_limit integer default 20)
returns table(id bigint)
language sql security definer set search_path = '' as $$
    select outbox.id from public.account_email_outbox outbox
     where outbox.status = 'sent' and outbox.sent_at < p_before and outbox.gmail_cleaned_at is null
     order by outbox.sent_at limit greatest(1, least(p_limit, 100));
$$;

create or replace function public.complete_lifecycle_email_cleanup(p_ids bigint[])
returns integer
language plpgsql security definer set search_path = '' as $$
declare removed integer;
begin
    delete from public.account_email_outbox where id = any(coalesce(p_ids, array[]::bigint[]))
      and gmail_cleaned_at is not null;
    get diagnostics removed = row_count;
    return removed;
end;
$$;

create or replace function public.mark_lifecycle_email_cleaned(p_ids bigint[])
returns integer
language plpgsql security definer set search_path = '' as $$
declare marked integer;
begin
    update public.account_email_outbox set gmail_cleaned_at = now(), updated_at = now()
     where id = any(coalesce(p_ids, array[]::bigint[])) and status = 'sent';
    get diagnostics marked = row_count;
    return marked;
end;
$$;

create or replace function public.scrub_account_deletion_token()
returns trigger language plpgsql set search_path = '' as $$
begin
    if new.event_type = 'external_deletion_verify'
       and new.status in ('sent', 'cancelled', 'dead') then
        new.payload := new.payload - 'verification_token';
    end if;
    return new;
end;
$$;

drop trigger if exists scrub_account_deletion_token_on_outbox on public.account_email_outbox;
create trigger scrub_account_deletion_token_on_outbox
before update on public.account_email_outbox
for each row execute function public.scrub_account_deletion_token();

create or replace function public.preview_account_rights_daily(p_now timestamptz default now())
returns jsonb language sql stable security definer set search_path = '' as $$
    select jsonb_build_object(
        'enabled', cfg.account_rights_enabled,
        'pending_exports', (select count(*) from public.account_export_jobs where status in ('pending', 'retry')),
        'expired_exports', (select count(*) from public.account_export_jobs where status = 'expired' or (status = 'ready' and expires_at <= p_now)),
        'pending_deletions', (select count(*) from public.account_deletion_jobs where status in ('pending', 'retry')),
        'overdue_deletions', (select count(*) from public.account_deletion_jobs where status <> 'completed' and requested_at < p_now - interval '30 days'),
        'due_lifecycle_email_cleanup', (select count(*) from public.account_email_outbox where status = 'sent' and sent_at < p_now - interval '24 months' and gmail_cleaned_at is null)
    ) from public.account_lifecycle_config cfg where singleton_id = 1;
$$;

create or replace function public.account_rights_setup_audit()
returns jsonb language sql stable security definer set search_path = '' as $$
    select jsonb_build_object(
        'enabled', (select account_rights_enabled from public.account_lifecycle_config where singleton_id = 1),
        'export_bucket_private', (select not public from storage.buckets where id = 'user-data-exports'),
        'exports', (select count(*) from public.account_export_jobs),
        'deletions', (select count(*) from public.account_deletion_jobs),
        'external_requests', (select count(*) from public.account_external_deletion_requests)
    );
$$;

-- Extend the lifecycle outbox with the verification message type.
alter table public.account_email_outbox drop constraint if exists account_email_outbox_event_type_check;
alter table public.account_email_outbox add constraint account_email_outbox_event_type_check check (event_type in (
    'terms_started', 'terms_six_months', 'terms_30_days', 'terms_7_days', 'terms_expired',
    'inactive_started', 'inactive_six_months', 'inactive_30_days', 'inactive_7_days', 'inactive_expired',
    'external_deletion_verify'
));

revoke all on public.account_export_jobs, public.account_external_deletion_requests,
    public.account_deletion_jobs, public.account_rights_secrets from public, anon, authenticated;
grant select on public.account_export_jobs to authenticated;
grant all on public.account_export_jobs, public.account_external_deletion_requests,
    public.account_deletion_jobs, public.account_rights_secrets to service_role;

revoke all on function public.request_external_account_deletion(text) from public;
grant execute on function public.request_external_account_deletion(text) to anon, authenticated, service_role;
revoke all on function public.request_my_account_deletion_verification() from public, anon;
revoke all on function public.request_my_data_export() from public, anon;
grant execute on function public.request_my_account_deletion_verification() to authenticated;
grant execute on function public.request_my_data_export() to authenticated;
revoke all on function public.confirm_account_deletion(text) from public;
grant execute on function public.confirm_account_deletion(text) to anon, authenticated, service_role;

revoke all on function public.prepare_account_rights_daily(timestamptz) from public, anon, authenticated;
revoke all on function public.claim_next_account_export(uuid, integer) from public, anon, authenticated;
revoke all on function public.complete_account_export(uuid, uuid, bigint, text) from public, anon, authenticated;
revoke all on function public.fail_account_export(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.claim_expired_account_export(uuid) from public, anon, authenticated;
revoke all on function public.complete_expired_account_export(uuid, uuid) from public, anon, authenticated;
revoke all on function public.claim_next_account_deletion(uuid) from public, anon, authenticated;
revoke all on function public.mark_deletion_email_cleanup_complete(uuid, uuid, bigint[]) from public, anon, authenticated;
revoke all on function public.advance_account_deletion(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.fail_account_deletion(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.list_due_lifecycle_email_cleanup(timestamptz, integer) from public, anon, authenticated;
revoke all on function public.complete_lifecycle_email_cleanup(bigint[]) from public, anon, authenticated;
revoke all on function public.mark_lifecycle_email_cleaned(bigint[]) from public, anon, authenticated;
revoke all on function public.scrub_account_deletion_token() from public, anon, authenticated;
revoke all on function public.preview_account_rights_daily(timestamptz) from public, anon, authenticated;
revoke all on function public.account_rights_setup_audit() from public, anon, authenticated;

grant execute on function public.prepare_account_rights_daily(timestamptz) to service_role;
grant execute on function public.claim_next_account_export(uuid, integer) to service_role;
grant execute on function public.complete_account_export(uuid, uuid, bigint, text) to service_role;
grant execute on function public.fail_account_export(uuid, uuid, text) to service_role;
grant execute on function public.claim_expired_account_export(uuid) to service_role;
grant execute on function public.complete_expired_account_export(uuid, uuid) to service_role;
grant execute on function public.claim_next_account_deletion(uuid) to service_role;
grant execute on function public.mark_deletion_email_cleanup_complete(uuid, uuid, bigint[]) to service_role;
grant execute on function public.advance_account_deletion(uuid, uuid, text) to service_role;
grant execute on function public.fail_account_deletion(uuid, uuid, text) to service_role;
grant execute on function public.list_due_lifecycle_email_cleanup(timestamptz, integer) to service_role;
grant execute on function public.complete_lifecycle_email_cleanup(bigint[]) to service_role;
grant execute on function public.mark_lifecycle_email_cleaned(bigint[]) to service_role;
grant execute on function public.preview_account_rights_daily(timestamptz) to service_role;
grant execute on function public.account_rights_setup_audit() to service_role;

comment on table public.account_export_jobs is 'Temporary private personal-data archives; objects expire independently of client access.';
comment on table public.account_deletion_jobs is 'Resumable email, Storage, database and Auth deletion state machine.';
comment on function public.request_external_account_deletion(text) is 'Non-enumerating public entry point; identity is proven only by the one-time mailbox token.';

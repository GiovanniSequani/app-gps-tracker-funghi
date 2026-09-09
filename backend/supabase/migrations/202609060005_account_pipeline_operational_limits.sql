-- Operational limits for the temporary manually launched account pipeline.
-- Idempotent and deliberately does not change lifecycle or rights switches.

begin;

update public.account_lifecycle_config
   set dispatcher_daily_limit = 100,
       dispatcher_pause_seconds = 5,
       updated_at = now()
 where singleton_id = 1;

do $$
declare
    cfg public.account_lifecycle_config%rowtype;
begin
    select * into strict cfg
      from public.account_lifecycle_config
     where singleton_id = 1;

    if cfg.dispatcher_daily_limit <> 100
       or cfg.dispatcher_pause_seconds <> 5 then
        raise exception 'account pipeline operational limits were not applied';
    end if;
end;
$$;

commit;

select jsonb_build_object(
    'dispatcher_daily_limit', dispatcher_daily_limit,
    'dispatcher_pause_seconds', dispatcher_pause_seconds,
    'lifecycle_enabled', lifecycle_enabled,
    'account_rights_enabled', account_rights_enabled
) as account_pipeline_config
from public.account_lifecycle_config
where singleton_id = 1;

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- Create these three secrets in Supabase Vault before running this migration:
-- selkalis_project_url, selkalis_anon_key, selkalis_reminder_cron_secret.
-- The last secret must match REMINDER_CRON_SECRET configured for the Edge Function.
DO $$
BEGIN
  IF (
    SELECT count(*)
    FROM vault.decrypted_secrets
    WHERE name IN (
      'selkalis_project_url',
      'selkalis_anon_key',
      'selkalis_reminder_cron_secret'
    )
  ) <> 3 THEN
    RAISE EXCEPTION 'Create the three required secrets in Supabase Vault before scheduling reminders.';
  END IF;
END;
$$;

SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname = 'selkalis-scheduled-reminders';

SELECT cron.schedule(
  'selkalis-scheduled-reminders',
  '* * * * *',
  $job$
    SELECT net.http_post(
      url := (
        SELECT decrypted_secret
        FROM vault.decrypted_secrets
        WHERE name = 'selkalis_project_url'
      ) || '/functions/v1/scheduled-reminders',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'apikey', (
          SELECT decrypted_secret
          FROM vault.decrypted_secrets
          WHERE name = 'selkalis_anon_key'
        ),
        'x-reminder-cron-secret', (
          SELECT decrypted_secret
          FROM vault.decrypted_secrets
          WHERE name = 'selkalis_reminder_cron_secret'
        )
      ),
      body := jsonb_build_object('scheduled_at', now()),
      timeout_milliseconds := 10000
    );
  $job$
);

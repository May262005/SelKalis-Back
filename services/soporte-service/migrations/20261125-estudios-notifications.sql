ALTER TABLE public.notification_preferences
  ADD COLUMN IF NOT EXISTS estudios_enabled boolean NOT NULL DEFAULT true;

ALTER TABLE public.app_notifications
  DROP CONSTRAINT IF EXISTS app_notifications_tipo_check;

ALTER TABLE public.app_notifications
  ADD CONSTRAINT app_notifications_tipo_check
  CHECK (tipo IN ('medicamento', 'cita', 'estudio', 'soporte'));

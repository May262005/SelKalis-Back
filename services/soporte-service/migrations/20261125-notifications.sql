CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.notification_preferences (
  usuario_id uuid PRIMARY KEY REFERENCES public.usuarios(id) ON DELETE CASCADE,
  push_enabled boolean NOT NULL DEFAULT false,
  medicamentos_enabled boolean NOT NULL DEFAULT true,
  citas_enabled boolean NOT NULL DEFAULT true,
  soporte_enabled boolean NOT NULL DEFAULT true,
  timezone text NOT NULL DEFAULT 'America/Mexico_City',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.notification_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id uuid NOT NULL REFERENCES public.usuarios(id) ON DELETE CASCADE,
  endpoint text NOT NULL UNIQUE,
  p256dh text NOT NULL,
  auth text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notification_subscriptions_usuario_id_idx
  ON public.notification_subscriptions(usuario_id);

CREATE TABLE IF NOT EXISTS public.app_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id uuid NOT NULL REFERENCES public.usuarios(id) ON DELETE CASCADE,
  tipo text NOT NULL CHECK (tipo IN ('medicamento', 'cita', 'soporte')),
  titulo text NOT NULL,
  mensaje text NOT NULL,
  datos jsonb NOT NULL DEFAULT '{}'::jsonb,
  event_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz
);

CREATE INDEX IF NOT EXISTS app_notifications_usuario_created_idx
  ON public.app_notifications(usuario_id, created_at DESC);

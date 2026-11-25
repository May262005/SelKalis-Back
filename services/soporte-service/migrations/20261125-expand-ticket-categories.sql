ALTER TABLE public.support_tickets
  ALTER COLUMN categoria DROP DEFAULT;

ALTER TABLE public.support_tickets
  ALTER COLUMN categoria TYPE text USING categoria::text;

DO $$
DECLARE
  category_check record;
BEGIN
  FOR category_check IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.support_tickets'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%categoria%'
  LOOP
    EXECUTE format(
      'ALTER TABLE public.support_tickets DROP CONSTRAINT %I',
      category_check.conname
    );
  END LOOP;
END $$;

ALTER TABLE public.support_tickets
  ALTER COLUMN categoria SET DEFAULT 'tecnica',
  ADD CONSTRAINT support_tickets_categoria_check
    CHECK (categoria IN (
      'tecnica',
      'cuenta',
      'citas',
      'estudios',
      'tratamientos',
      'documentos',
      'otro'
    ));

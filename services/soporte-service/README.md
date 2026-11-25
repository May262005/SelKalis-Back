# Servicio de soporte Sel Kalis

Incluye el ChatBox de atención y la mesa de ayuda con reportes, respuestas y seguimiento de estado.

## Configuración

Configura `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `JWT_SECRET` y `FRONTEND_URL` como variables del servicio. La clave `SUPABASE_SERVICE_ROLE_KEY` debe mantenerse únicamente en el servidor.

Ejecuta [`schema.sql`](./schema.sql) una vez en el SQL Editor del proyecto Supabase antes de iniciar el servicio. El servicio valida las sesiones JWT y comprueba el rol y estado actual de la cuenta en la tabla `usuarios`.

El despliegue Render usa el nombre `selkalis-soporte-service`; el frontend consume `https://selkalis-soporte-service.onrender.com`.

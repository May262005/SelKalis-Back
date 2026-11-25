const webpush = require('web-push');
const crypto = require('crypto');
const supabase = require('./db');

const defaultTimezone = 'America/Mexico_City';
const pushPublicKey = process.env.VAPID_PUBLIC_KEY || '';
const pushConfigured = Boolean(
  pushPublicKey
  && process.env.VAPID_PRIVATE_KEY
  && process.env.VAPID_SUBJECT
);

if (pushConfigured) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT,
    pushPublicKey,
    process.env.VAPID_PRIVATE_KEY
  );
} else {
  console.warn('Push deshabilitado: configura VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY y VAPID_SUBJECT.');
}

function defaultPreferences(usuarioId) {
  return {
    usuario_id: usuarioId,
    push_enabled: false,
    medicamentos_enabled: true,
    citas_enabled: true,
    soporte_enabled: true,
    timezone: defaultTimezone
  };
}

async function getPreferences(usuarioId) {
  const { data, error } = await supabase
    .from('notification_preferences')
    .select('*')
    .eq('usuario_id', usuarioId)
    .maybeSingle();

  if (error) throw error;
  return { ...defaultPreferences(usuarioId), ...(data || {}) };
}

function notificationUrl(notification) {
  const url = notification.datos?.url;
  if (typeof url === 'string' && url.startsWith('/') && !url.startsWith('//')) return url;
  if (notification.tipo === 'medicamento') return '/tratamientos';
  if (notification.tipo === 'cita') return '/citas';
  return '/soporte';
}

function pushEndpointRef(endpoint) {
  return crypto.createHash('sha256').update(endpoint).digest('hex').slice(0, 8);
}

async function sendPush(usuarioId, notification, preferences) {
  if (!pushConfigured || !preferences.push_enabled) return 0;

  const preferenceByType = {
    medicamento: 'medicamentos_enabled',
    cita: 'citas_enabled',
    soporte: 'soporte_enabled'
  };
  if (!preferences[preferenceByType[notification.tipo]]) return 0;

  const { data: subscriptions, error } = await supabase
    .from('notification_subscriptions')
    .select('endpoint, p256dh, auth')
    .eq('usuario_id', usuarioId);

  if (error) throw error;
  if (!subscriptions?.length) {
    console.info(`Push de tipo ${notification.tipo}: 0/0 suscripciones aceptadas.`);
    return 0;
  }

  const payload = JSON.stringify({
    notification: {
      title: notification.titulo,
      body: notification.mensaje,
      icon: '/icons/selkalis-192.png',
      badge: '/icons/selkalis-192.png',
      tag: notification.event_key,
      data: {
        onActionClick: {
          default: {
            operation: 'navigateLastFocusedOrOpen',
            url: notificationUrl(notification)
          }
        }
      }
    }
  });

  const deliveries = await Promise.all(subscriptions.map(async subscription => {
    const endpointRef = pushEndpointRef(subscription.endpoint);
    try {
      await webpush.sendNotification({
        endpoint: subscription.endpoint,
        keys: {
          p256dh: subscription.p256dh,
          auth: subscription.auth
        }
      }, payload);
      console.info(`Push de tipo ${notification.tipo} [${endpointRef}]: aceptado.`);
      return true;
    } catch (pushError) {
      if (pushError.statusCode === 404 || pushError.statusCode === 410) {
        const { error: deleteError } = await supabase
          .from('notification_subscriptions')
          .delete()
          .eq('endpoint', subscription.endpoint);
        if (deleteError) throw deleteError;
        console.info(`Suscripción push expirada eliminada [${endpointRef}].`);
        return false;
      }
      console.error(`Falló el push de tipo ${notification.tipo} [${endpointRef}], estado ${pushError.statusCode || 'desconocido'}.`);
      throw pushError;
    }
  }));
  const delivered = deliveries.filter(Boolean).length;
  console.info(`Push de tipo ${notification.tipo}: ${delivered}/${subscriptions.length} suscripciones aceptadas.`);
  return delivered;
}

async function notifyUser(usuarioId, notification) {
  const preferences = await getPreferences(usuarioId);
  const enabledByType = {
    medicamento: preferences.medicamentos_enabled,
    cita: preferences.citas_enabled,
    soporte: preferences.soporte_enabled
  };
  if (!enabledByType[notification.tipo]) return null;

  const { data, error } = await supabase
    .from('app_notifications')
    .insert({
      usuario_id: usuarioId,
      tipo: notification.tipo,
      titulo: notification.titulo,
      mensaje: notification.mensaje,
      datos: notification.datos || {},
      event_key: notification.event_key
    })
    .select('*')
    .single();

  if (error?.code === '23505') return null;
  if (error) throw error;

  await sendPush(usuarioId, data, preferences);
  return data;
}

async function notifyAdmins(notification) {
  const { data: admins, error } = await supabase
    .from('usuarios')
    .select('id')
    .eq('rol', 'admin')
    .eq('activo', true);

  if (error) throw error;

  await Promise.all((admins || []).map(admin => notifyUser(admin.id, {
    ...notification,
    event_key: `${notification.event_key}:admin:${admin.id}`
  })));
}

module.exports = {
  pushConfigured,
  pushPublicKey,
  defaultPreferences,
  getPreferences,
  notifyUser,
  notifyAdmins
};

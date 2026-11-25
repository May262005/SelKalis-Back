const webpush = require('web-push');
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

function genericPushMessage(tipo) {
  if (tipo === 'medicamento') return 'Tienes un recordatorio de medicamento. Abre Sel Kalis para ver los detalles.';
  if (tipo === 'cita') return 'Tienes un recordatorio de cita. Abre Sel Kalis para ver los detalles.';
  return 'Hay una actualización en tu solicitud de soporte. Abre Sel Kalis para revisarla.';
}

function notificationUrl(tipo) {
  if (tipo === 'medicamento') return '/tratamientos';
  if (tipo === 'cita') return '/citas';
  return '/soporte';
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
  if (!subscriptions?.length) return 0;

  const payload = JSON.stringify({
    notification: {
      title: 'Sel Kalis',
      body: genericPushMessage(notification.tipo),
      icon: '/icons/selkalis-192.png',
      badge: '/icons/selkalis-192.png',
      tag: notification.event_key,
      data: {
        onActionClick: {
          default: {
            operation: 'navigateLastFocusedOrOpen',
            url: notificationUrl(notification.tipo)
          }
        }
      }
    }
  });

  const deliveries = await Promise.all(subscriptions.map(async subscription => {
    try {
      await webpush.sendNotification({
        endpoint: subscription.endpoint,
        keys: {
          p256dh: subscription.p256dh,
          auth: subscription.auth
        }
      }, payload);
      return true;
    } catch (pushError) {
      if (pushError.statusCode === 404 || pushError.statusCode === 410) {
        const { error: deleteError } = await supabase
          .from('notification_subscriptions')
          .delete()
          .eq('endpoint', subscription.endpoint);
        if (deleteError) throw deleteError;
        console.info('Suscripción push expirada eliminada.');
        return false;
      }
      throw pushError;
    }
  }));
  return deliveries.filter(Boolean).length;
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

function formatLocalDateTime(date, timezone) {
  const safeTimezone = timezone || defaultTimezone;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: safeTimezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`;
}

function shiftLocalDateTime(value, minutes) {
  const [date, time] = value.split('T');
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day, hour, minute + minutes));
  const pad = number => String(number).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`;
}

function isDueInCurrentWindow(dueAt, nowLocal) {
  const toMinutes = value => {
    const [date, time] = value.split('T');
    const [year, month, day] = date.split('-').map(Number);
    const [hour, minute] = time.split(':').map(Number);
    return Date.UTC(year, month - 1, day, hour, minute) / 60000;
  };
  const elapsedMinutes = toMinutes(nowLocal) - toMinutes(dueAt);
  return elapsedMinutes >= 0 && elapsedMinutes < 2;
}

async function scanMedicationReminders(now = new Date()) {
  const { data: treatments, error } = await supabase
    .from('tratamientos')
    .select('id, usuario_id, estado, activo, medicamentos(id, nombre, dosis, instrucciones, activo, tomas)')
    .eq('estado', 'activo')
    .eq('activo', true);

  if (error) throw error;

  for (const treatment of treatments || []) {
    const preferences = await getPreferences(treatment.usuario_id);
    if (!preferences.medicamentos_enabled) continue;

    const nowLocal = formatLocalDateTime(now, preferences.timezone);
    for (const medicine of treatment.medicamentos || []) {
      if (medicine.activo === false) continue;
      for (const dose of medicine.tomas || []) {
        if (dose.completado || !dose.fecha || !dose.hora) continue;
        const scheduledAt = `${dose.fecha}T${dose.hora.slice(0, 5)}`;
        const dueAt = shiftLocalDateTime(scheduledAt, -15);
        if (!isDueInCurrentWindow(dueAt, nowLocal)) continue;

        const instruction = [medicine.dosis, medicine.instrucciones].filter(Boolean).join(' · ');
        await notifyUser(treatment.usuario_id, {
          tipo: 'medicamento',
          titulo: `Recordatorio: ${medicine.nombre}`,
          mensaje: `En 15 minutos corresponde la toma programada para las ${dose.hora.slice(0, 5)}.${instruction ? ` Indicación: ${instruction}.` : ''}`,
          event_key: `medicine:${medicine.id}:${dose.fecha}:${dose.hora}`,
          datos: {
            url: '/tratamientos',
            medicamento_id: medicine.id,
            tratamiento_id: treatment.id,
            hora: dose.hora,
            indicacion: instruction
          }
        });
      }
    }
  }
}

async function scanAppointmentReminders(now = new Date()) {
  const utcDate = now.toISOString().slice(0, 10);
  const fromDate = shiftLocalDateTime(`${utcDate}T00:00`, -1440).slice(0, 10);
  const toDate = shiftLocalDateTime(`${utcDate}T00:00`, 4 * 1440).slice(0, 10);
  const { data: appointments, error } = await supabase
    .from('citas')
    .select('id, usuario_id, titulo, fecha, hora, estado, recordatorio')
    .gte('fecha', fromDate)
    .lte('fecha', toDate);

  if (error) throw error;

  for (const appointment of appointments || []) {
    if (appointment.recordatorio === false || ['cancelada', 'completada'].includes(appointment.estado)) continue;
    const preferences = await getPreferences(appointment.usuario_id);
    if (!preferences.citas_enabled) continue;

    const nowLocal = formatLocalDateTime(now, preferences.timezone);
    const scheduledAt = `${appointment.fecha}T${appointment.hora.slice(0, 5)}`;
    for (const leadMinutes of [1440, 60]) {
      const dueAt = shiftLocalDateTime(scheduledAt, -leadMinutes);
      if (!isDueInCurrentWindow(dueAt, nowLocal)) continue;

      const leadLabel = leadMinutes === 1440 ? '24 horas' : '1 hora';
      await notifyUser(appointment.usuario_id, {
        tipo: 'cita',
        titulo: `Recordatorio de cita: ${appointment.titulo}`,
        mensaje: `Tu cita es en ${leadLabel}, el ${appointment.fecha} a las ${appointment.hora.slice(0, 5)}.`,
        event_key: `appointment:${appointment.id}:${leadMinutes}:${appointment.fecha}:${appointment.hora}`,
        datos: {
          url: '/citas',
          cita_id: appointment.id,
          fecha: appointment.fecha,
          hora: appointment.hora
        }
      });
    }
  }
}

let reminderScanRunning = false;

async function runReminderScan() {
  if (reminderScanRunning) return;
  reminderScanRunning = true;
  try {
    await Promise.all([scanMedicationReminders(), scanAppointmentReminders()]);
  } catch (error) {
    console.error('Error al generar recordatorios programados:', error);
  } finally {
    reminderScanRunning = false;
  }
}

function startReminderScheduler() {
  void runReminderScan();
  return setInterval(() => void runReminderScan(), 30_000);
}

module.exports = {
  pushConfigured,
  pushPublicKey,
  defaultPreferences,
  getPreferences,
  sendPush,
  notifyUser,
  notifyAdmins,
  startReminderScheduler
};

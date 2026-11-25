// @deno-types="npm:@types/web-push@3.6.4"
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

const defaultTimezone = "America/Mexico_City";
const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceRoleKey = Deno.env.get("SERVICE_ROLE_KEY");
const pushPublicKey = Deno.env.get("VAPID_PUBLIC_KEY");
const pushPrivateKey = Deno.env.get("VAPID_PRIVATE_KEY");
const pushSubject = Deno.env.get("VAPID_SUBJECT");
const cronSecret = Deno.env.get("REMINDER_CRON_SECRET");

const missingConfiguration = [
  ["SUPABASE_URL", supabaseUrl],
  ["SERVICE_ROLE_KEY", serviceRoleKey],
  ["VAPID_PUBLIC_KEY", pushPublicKey],
  ["VAPID_PRIVATE_KEY", pushPrivateKey],
  ["VAPID_SUBJECT", pushSubject],
  ["REMINDER_CRON_SECRET", cronSecret]
].filter(([, value]) => !value).map(([name]) => name);

const supabase = supabaseUrl && serviceRoleKey
  ? createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  })
  : null;

if (pushPublicKey && pushPrivateKey && pushSubject) {
  webpush.setVapidDetails(pushSubject, pushPublicKey, pushPrivateKey);
}

type NotificationType = "medicamento" | "cita";

type NotificationPreferences = {
  usuario_id: string;
  push_enabled: boolean;
  medicamentos_enabled: boolean;
  citas_enabled: boolean;
  soporte_enabled: boolean;
  timezone: string;
};

function defaultPreferences(usuarioId: string): NotificationPreferences {
  return {
    usuario_id: usuarioId,
    push_enabled: false,
    medicamentos_enabled: true,
    citas_enabled: true,
    soporte_enabled: true,
    timezone: defaultTimezone
  };
}

async function getPreferences(usuarioId: string): Promise<NotificationPreferences> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { data, error } = await supabase
    .from("notification_preferences")
    .select("*")
    .eq("usuario_id", usuarioId)
    .maybeSingle();

  if (error) throw error;
  return { ...defaultPreferences(usuarioId), ...(data || {}) };
}

function notificationUrl(notification: {
  tipo: NotificationType;
  datos?: { url?: unknown } | null;
}): string {
  const url = notification.datos?.url;
  if (typeof url === "string" && url.startsWith("/") && !url.startsWith("//")) return url;
  return notification.tipo === "medicamento" ? "/tratamientos" : "/citas";
}

async function pushEndpointRef(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return Array.from(new Uint8Array(digest))
    .slice(0, 4)
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sendPush(
  usuarioId: string,
  notification: {
    tipo: NotificationType;
    titulo: string;
    mensaje: string;
    event_key: string;
    datos?: { url?: unknown } | null;
  },
  preferences: NotificationPreferences
): Promise<number> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  if (!preferences.push_enabled) return 0;
  if (notification.tipo === "medicamento" && !preferences.medicamentos_enabled) return 0;
  if (notification.tipo === "cita" && !preferences.citas_enabled) return 0;

  const { data: subscriptions, error } = await supabase
    .from("notification_subscriptions")
    .select("endpoint, p256dh, auth")
    .eq("usuario_id", usuarioId);

  if (error) throw error;
  if (!subscriptions?.length) {
    console.info(`Push de tipo ${notification.tipo}: 0/0 suscripciones aceptadas.`);
    return 0;
  }

  const payload = JSON.stringify({
    notification: {
      title: notification.titulo,
      body: notification.mensaje,
      icon: "/icons/selkalis-192.png",
      badge: "/icons/selkalis-192.png",
      tag: notification.event_key,
      data: {
        onActionClick: {
          default: {
            operation: "navigateLastFocusedOrOpen",
            url: notificationUrl(notification)
          }
        }
      }
    }
  });

  const deliveries = await Promise.all(subscriptions.map(async subscription => {
    const endpointRef = await pushEndpointRef(subscription.endpoint);
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
      const statusCode = pushError && typeof pushError === "object" && "statusCode" in pushError
        ? pushError.statusCode
        : undefined;
      const status = typeof statusCode === "number" ? statusCode : undefined;
      if (status === 404 || status === 410) {
        const { error: deleteError } = await supabase
          .from("notification_subscriptions")
          .delete()
          .eq("endpoint", subscription.endpoint);
        if (deleteError) throw deleteError;
        console.info(`Suscripción push expirada eliminada [${endpointRef}].`);
        return false;
      }

      console.error(
        `Falló el push de tipo ${notification.tipo} [${endpointRef}], estado ${status || "desconocido"}.`
      );
      return false;
    }
  }));

  const delivered = deliveries.filter(Boolean).length;
  console.info(`Push de tipo ${notification.tipo}: ${delivered}/${subscriptions.length} suscripciones aceptadas.`);
  return delivered;
}

async function notifyUser(
  usuarioId: string,
  notification: {
    tipo: NotificationType;
    titulo: string;
    mensaje: string;
    event_key: string;
    datos: Record<string, unknown>;
  },
  preferences: NotificationPreferences
): Promise<boolean> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  if (notification.tipo === "medicamento" && !preferences.medicamentos_enabled) return false;
  if (notification.tipo === "cita" && !preferences.citas_enabled) return false;

  const { data, error } = await supabase
    .from("app_notifications")
    .insert({
      usuario_id: usuarioId,
      tipo: notification.tipo,
      titulo: notification.titulo,
      mensaje: notification.mensaje,
      datos: notification.datos,
      event_key: notification.event_key
    })
    .select("*")
    .single();

  if (error?.code === "23505") return false;
  if (error) throw error;

  await sendPush(usuarioId, data, preferences);
  return true;
}

function formatLocalDateTime(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone || defaultTimezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`;
}

function shiftLocalDateTime(value: string, minutes: number): string {
  const [date, time] = value.split("T");
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day, hour, minute + minutes));
  const pad = (number: number) => String(number).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`;
}

function isDueInCurrentWindow(dueAt: string, nowLocal: string): boolean {
  const toMinutes = (value: string) => {
    const [date, time] = value.split("T");
    const [year, month, day] = date.split("-").map(Number);
    const [hour, minute] = time.split(":").map(Number);
    return Date.UTC(year, month - 1, day, hour, minute) / 60000;
  };
  const elapsedMinutes = toMinutes(nowLocal) - toMinutes(dueAt);
  return elapsedMinutes >= 0 && elapsedMinutes < 10;
}

async function scanMedicationReminders(now: Date): Promise<number> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { data: treatments, error } = await supabase
    .from("tratamientos")
    .select("id, usuario_id, estado, activo, medicamentos(id, nombre, dosis, instrucciones, activo, tomas)")
    .eq("estado", "activo")
    .eq("activo", true);

  if (error) throw error;

  let created = 0;
  const preferencesByUser = new Map<string, Promise<NotificationPreferences>>();
  for (const treatment of treatments || []) {
    if (!preferencesByUser.has(treatment.usuario_id)) {
      preferencesByUser.set(treatment.usuario_id, getPreferences(treatment.usuario_id));
    }
    const preferences = await preferencesByUser.get(treatment.usuario_id)!;
    if (!preferences.medicamentos_enabled) continue;

    const nowLocal = formatLocalDateTime(now, preferences.timezone);
    for (const medicine of treatment.medicamentos || []) {
      if (medicine.activo === false) continue;
      for (const dose of medicine.tomas || []) {
        if (dose.completado || !dose.fecha || !dose.hora) continue;
        const scheduledAt = `${dose.fecha}T${dose.hora.slice(0, 5)}`;
        const dueAt = shiftLocalDateTime(scheduledAt, -15);
        if (!isDueInCurrentWindow(dueAt, nowLocal)) continue;

        const instruction = [medicine.dosis, medicine.instrucciones].filter(Boolean).join(" · ");
        const inserted = await notifyUser(treatment.usuario_id, {
          tipo: "medicamento",
          titulo: `Recordatorio: ${medicine.nombre}`,
          mensaje: `En 15 minutos corresponde la toma programada para las ${dose.hora.slice(0, 5)}.${instruction ? ` Indicación: ${instruction}.` : ""}`,
          event_key: `medicine:${medicine.id}:${dose.fecha}:${dose.hora}`,
          datos: {
            url: "/tratamientos",
            medicamento_id: medicine.id,
            tratamiento_id: treatment.id,
            hora: dose.hora,
            indicacion: instruction
          }
        }, preferences);
        if (inserted) created++;
      }
    }
  }
  return created;
}

async function scanAppointmentReminders(now: Date): Promise<number> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const utcDate = now.toISOString().slice(0, 10);
  const fromDate = shiftLocalDateTime(`${utcDate}T00:00`, -1440).slice(0, 10);
  const toDate = shiftLocalDateTime(`${utcDate}T00:00`, 4 * 1440).slice(0, 10);
  const { data: appointments, error } = await supabase
    .from("citas")
    .select("id, usuario_id, titulo, fecha, hora, estado, recordatorio")
    .gte("fecha", fromDate)
    .lte("fecha", toDate);

  if (error) throw error;

  let created = 0;
  const preferencesByUser = new Map<string, Promise<NotificationPreferences>>();
  for (const appointment of appointments || []) {
    if (appointment.recordatorio === false || appointment.estado === "cancelada") continue;
    if (!preferencesByUser.has(appointment.usuario_id)) {
      preferencesByUser.set(appointment.usuario_id, getPreferences(appointment.usuario_id));
    }
    const preferences = await preferencesByUser.get(appointment.usuario_id)!;
    if (!preferences.citas_enabled) continue;

    const nowLocal = formatLocalDateTime(now, preferences.timezone);
    const scheduledAt = `${appointment.fecha}T${appointment.hora.slice(0, 5)}`;
    if (appointment.estado === "completada" && scheduledAt <= nowLocal) continue;
    for (const leadMinutes of [1440, 60]) {
      const dueAt = shiftLocalDateTime(scheduledAt, -leadMinutes);
      if (!isDueInCurrentWindow(dueAt, nowLocal)) continue;

      const leadLabel = leadMinutes === 1440 ? "24 horas" : "1 hora";
      const inserted = await notifyUser(appointment.usuario_id, {
        tipo: "cita",
        titulo: `Recordatorio de cita: ${appointment.titulo}`,
        mensaje: `Tu cita es en ${leadLabel}, el ${appointment.fecha} a las ${appointment.hora.slice(0, 5)}.`,
        event_key: `appointment:${appointment.id}:${leadMinutes}:${appointment.fecha}:${appointment.hora}`,
        datos: {
          url: "/citas",
          cita_id: appointment.id,
          fecha: appointment.fecha,
          hora: appointment.hora
        }
      }, preferences);
      if (inserted) created++;
    }
  }
  return created;
}

function timingSafeEqual(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  if (aBytes.length !== bBytes.length) return false;
  let mismatch = 0;
  for (let index = 0; index < aBytes.length; index++) mismatch |= aBytes[index] ^ bBytes[index];
  return mismatch === 0;
}

Deno.serve(async request => {
  if (request.method !== "POST") {
    return Response.json({ error: "Método no permitido." }, { status: 405 });
  }

  if (missingConfiguration.length > 0) {
    console.error(`Configuración incompleta: ${missingConfiguration.join(", ")}.`);
    return Response.json({ error: "El servicio de recordatorios no está configurado." }, { status: 503 });
  }

  const providedSecret = request.headers.get("x-reminder-cron-secret") || "";
  if (!timingSafeEqual(providedSecret, cronSecret!)) {
    return Response.json({ error: "No autorizado." }, { status: 401 });
  }

  try {
    const now = new Date();
    const [medicationReminders, appointmentReminders] = await Promise.all([
      scanMedicationReminders(now),
      scanAppointmentReminders(now)
    ]);
    return Response.json({
      success: true,
      medicationReminders,
      appointmentReminders
    });
  } catch (error) {
    console.error(
      "Error al generar recordatorios programados:",
      error instanceof Error ? error.message : "Error desconocido."
    );
    return Response.json({ error: "No se pudieron procesar los recordatorios." }, { status: 500 });
  }
});

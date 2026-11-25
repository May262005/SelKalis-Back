const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const supabase = require('./db');
const { citaYaPaso } = require('./date-time');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const app = express();
const PORT = process.env.CITAS_SERVICE_PORT || 3003;

// ==================== CORS CONFIGURACIÓN CORREGIDA ====================
// Limpiar la URL de la barra al final
const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:4200').replace(/\/$/, '');
const allowedOrigins = [frontendUrl, frontendUrl + '/'];

console.log(`CORS permitido para: ${frontendUrl}`);

// Middleware CORS manual
app.use((req, res, next) => {
  const origin = req.headers.origin;
  
  // Verificar si el origen está permitido (con o sin barra)
  if (origin && (origin === frontendUrl || origin === frontendUrl + '/')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, X-Timezone');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Max-Age', '86400');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  next();
});

app.use(express.json());

const verifyToken = (req, res, next) => {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) {
    return res.status(401).json({ success: false, error: 'Token no proporcionado' });
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.usuario_id = decoded.id;
    next();
  } catch (error) {
    res.status(401).json({ success: false, error: 'Token inválido' });
  }
};

function notificarCambioCita(req, cita, eventType) {
  const notificationsUrl = process.env.NOTIFICATIONS_API_URL;
  const authorization = req.headers.authorization;
  if (!notificationsUrl || !authorization) {
    console.warn('Notificación de cita omitida: configura NOTIFICATIONS_API_URL y conserva el token autenticado.');
    return;
  }

  const eventKey = `${cita.id}:${cita.updated_at || cita.created_at || new Date().toISOString()}:${eventType}`;
  void fetch(`${notificationsUrl.replace(/\/$/, '')}/notifications/events/appointment`, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ eventType, eventKey, appointment: cita })
  }).then(async response => {
    if (!response.ok) {
      console.error(`Notificación de cita no aceptada por soporte: ${response.status} ${await response.text()}`);
    }
  }).catch(error => {
    console.error('No se pudo enviar el evento de cita al servicio de notificaciones:', error);
  });
}

// ==================== HEALTH CHECK ====================
app.get('/health', (req, res) => {
  res.json({ status: 'OK', service: 'citas-service' });
});

// ==================== ZONA HORARIA ====================
function obtenerTimezone(req) {
  const tz = req.headers['x-timezone'];
  if (!tz) return 'UTC';
  try {
    Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

// ==================== ENDPOINTS ====================

// GET: Obtener todas las citas del usuario
app.get('/citas', verifyToken, async (req, res) => {
  try {
    const timezone = obtenerTimezone(req);
    
    const { data, error } = await supabase
      .from('citas')
      .select('*')
      .eq('usuario_id', req.usuario_id)
      .order('fecha', { ascending: false })
      .order('hora', { ascending: false });

    if (error) throw error;

    const citasConEstado = data.map(cita => {
      const estado = cita.estado === 'cancelada'
        ? 'cancelada'
        : citaYaPaso(cita.fecha, cita.hora, timezone) ? 'completada' : 'pendiente';
      
      return { ...cita, estado };
    });

    res.json({ success: true, data: citasConEstado });
  } catch (error) {
    console.error('Error en GET /citas:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET: Obtener una cita específica
app.get('/citas/:id', verifyToken, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('citas')
      .select('*')
      .eq('id', req.params.id)
      .eq('usuario_id', req.usuario_id)
      .single();

    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST: Crear una nueva cita (registrar cita que ya te dio el médico)
app.post('/citas', verifyToken, async (req, res) => {
  try {
    const { titulo, especialidad, fecha, hora, tipo, lugar, notas, recordatorio } = req.body;

    // Validaciones
    if (!titulo || !especialidad || !fecha || !hora || !tipo) {
      return res.status(400).json({
        success: false,
        error: 'Faltan campos obligatorios: titulo, especialidad, fecha, hora, tipo'
      });
    }

    // Si la cita ya pasó, marcarla como completada
    const estado = citaYaPaso(fecha, hora, obtenerTimezone(req)) ? 'completada' : 'pendiente';

    const { data, error } = await supabase
      .from('citas')
      .insert([{
        usuario_id: req.usuario_id,
        titulo,
        especialidad,
        fecha,
        hora,
        tipo,
        lugar: lugar || null,
        notas: notas || null,
        estado,
        recordatorio: recordatorio !== undefined ? recordatorio : true
      }])
      .select()
      .single();

    if (error) throw error;
    notificarCambioCita(req, data, 'created');
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error en POST /citas:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// PUT: Actualizar una cita
app.put('/citas/:id', verifyToken, async (req, res) => {
  try {
    const { titulo, especialidad, fecha, hora, tipo, lugar, notas, recordatorio } = req.body;

    const { data: existingCita, error: checkError } = await supabase
      .from('citas')
      .select('*')
      .eq('id', req.params.id)
      .eq('usuario_id', req.usuario_id)
      .single();

    if (checkError) throw checkError;

    const timezone = obtenerTimezone(req);
    const estado = citaYaPaso(
      fecha || existingCita.fecha,
      hora || existingCita.hora,
      timezone
    ) ? 'completada' : 'pendiente';

    const { data, error } = await supabase
      .from('citas')
      .update({
        titulo,
        especialidad,
        fecha,
        hora,
        tipo,
        lugar: lugar || null,
        notas: notas || null,
        estado,
        recordatorio: recordatorio !== undefined ? recordatorio : true,
        updated_at: new Date().toISOString()
      })
      .eq('id', req.params.id)
      .eq('usuario_id', req.usuario_id)
      .select()
      .single();

    if (error) throw error;
    const appointmentChanged = existingCita.titulo !== data.titulo
      || existingCita.especialidad !== data.especialidad
      || existingCita.fecha !== data.fecha
      || existingCita.hora !== data.hora
      || existingCita.tipo !== data.tipo
      || existingCita.lugar !== data.lugar
      || existingCita.notas !== data.notas;
    if (appointmentChanged) notificarCambioCita(req, data, 'updated');
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error en PUT /citas/:id:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// PATCH: Actualizar estado de una cita (completada/cancelada)
app.patch('/citas/:id/estado', verifyToken, async (req, res) => {
  try {
    const { estado } = req.body;
    
    if (!['pendiente', 'completada', 'cancelada'].includes(estado)) {
      return res.status(400).json({
        success: false,
        error: 'Estado no válido. Debe ser: pendiente, completada o cancelada'
      });
    }

    const { data: previousCita, error: previousError } = await supabase
      .from('citas')
      .select('estado')
      .eq('id', req.params.id)
      .eq('usuario_id', req.usuario_id)
      .single();
    if (previousError) throw previousError;

    const { data, error } = await supabase
      .from('citas')
      .update({
        estado,
        updated_at: new Date().toISOString()
      })
      .eq('id', req.params.id)
      .eq('usuario_id', req.usuario_id)
      .select()
      .single();

    if (error) throw error;
    if (previousCita.estado !== data.estado) notificarCambioCita(req, data, 'status_changed');
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error en PATCH /citas/:id/estado:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE: Eliminar una cita (soft delete o real)
app.delete('/citas/:id', verifyToken, async (req, res) => {
  try {
    const { data: cita, error: selectError } = await supabase
      .from('citas')
      .select('*')
      .eq('id', req.params.id)
      .eq('usuario_id', req.usuario_id)
      .single();
    if (selectError) throw selectError;

    const { error } = await supabase
      .from('citas')
      .delete()
      .eq('id', req.params.id)
      .eq('usuario_id', req.usuario_id);

    if (error) throw error;
    notificarCambioCita(req, { ...cita, estado: 'cancelada', updated_at: new Date().toISOString() }, 'status_changed');
    res.json({ success: true });
  } catch (error) {
    console.error('Error en DELETE /citas/:id:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET: Obtener citas por mes (para vista de calendario)
app.get('/citas/mes/:mes/:anio', verifyToken, async (req, res) => {
  try {
    const { mes, anio } = req.params;
    const mesNum = parseInt(mes);
    const anioNum = parseInt(anio);

    // Validar mes y año
    if (mesNum < 1 || mesNum > 12 || anioNum < 2000 || anioNum > 2100) {
      return res.status(400).json({
        success: false,
        error: 'Mes o año inválido'
      });
    }

    const fechaInicio = `${anioNum}-${mesNum.toString().padStart(2, '0')}-01`;
    const fechaFin = `${anioNum}-${mesNum.toString().padStart(2, '0')}-${new Date(anioNum, mesNum, 0).getDate()}`;

    const { data, error } = await supabase
      .from('citas')
      .select('*')
      .eq('usuario_id', req.usuario_id)
      .gte('fecha', fechaInicio)
      .lte('fecha', fechaFin)
      .order('fecha', { ascending: true })
      .order('hora', { ascending: true });

    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error en GET /citas/mes/:mes/:anio:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== START SERVER ====================
app.listen(PORT, () => {
  console.log(`Citas Service running on port ${PORT}`);
  console.log(`CORS permitido para: ${frontendUrl}`);
});
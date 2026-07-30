const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const supabase = require('./db');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const app = express();
const PORT = process.env.CITAS_SERVICE_PORT || 3003;

// ==================== MIDDLEWARES ====================
app.use(cors());
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

    // Calcular estado real basado en fecha/hora actual
    const ahora = new Date();
    const citasConEstado = data.map(cita => {
      const fechaCita = new Date(cita.fecha + 'T' + cita.hora);
      let estado = cita.estado;
      
      // Si la cita ya pasó y no está cancelada, marcarla como completada
      if (fechaCita < ahora && cita.estado !== 'cancelada') {
        estado = 'completada';
      }
      
      return { ...cita, estado };
    });

    res.json({ success: true, data: citasConEstado });
  } catch (error) {
    console.error('❌ Error en GET /citas:', error);
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

    // Validar que la fecha no sea demasiado antigua (opcional)
    const fechaCita = new Date(fecha + 'T' + hora);
    const ahora = new Date();
    
    // Si la cita ya pasó, marcarla como completada
    const estado = fechaCita < ahora ? 'completada' : 'pendiente';

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
    res.json({ success: true, data });
  } catch (error) {
    console.error('❌ Error en POST /citas:', error);
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

    // Calcular estado basado en fecha/hora
    const fechaCita = new Date(fecha + 'T' + hora);
    const ahora = new Date();
    const estado = fechaCita < ahora ? 'completada' : 'pendiente';

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
    res.json({ success: true, data });
  } catch (error) {
    console.error('❌ Error en PUT /citas/:id:', error);
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
    res.json({ success: true, data });
  } catch (error) {
    console.error('❌ Error en PATCH /citas/:id/estado:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE: Eliminar una cita (soft delete o real)
app.delete('/citas/:id', verifyToken, async (req, res) => {
  try {
    const { error } = await supabase
      .from('citas')
      .delete()
      .eq('id', req.params.id)
      .eq('usuario_id', req.usuario_id);

    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Error en DELETE /citas/:id:', error);
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
    console.error('❌ Error en GET /citas/mes/:mes/:anio:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== START SERVER ====================
app.listen(PORT, () => {
  console.log(`✅ Citas Service running on port ${PORT}`);
});
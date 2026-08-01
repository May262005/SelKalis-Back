const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const supabase = require('./db');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const app = express();
const PORT = process.env.ESTUDIOS_SERVICE_PORT || 3004;

// ==================== CORS ====================
const allowedOrigins = (process.env.FRONTEND_URL || 'http://localhost:4200')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: allowedOrigins,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// ==================== VERIFY TOKEN ====================
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
    console.error('❌ Error al verificar token:', error.message);
    res.status(401).json({ success: false, error: 'Token inválido' });
  }
};

// ==================== HEALTH CHECK ====================
app.get('/estudios/health', (req, res) => {
  res.json({ status: 'OK', service: 'estudios-service', port: PORT });
});

// ==================== GET ESTUDIOS ====================
app.get('/estudios', verifyToken, async (req, res) => {
  try {
    console.log('👤 Usuario ID desde token:', req.usuario_id);

    const { data, error } = await supabase
      .from('estudios')
      .select('*')
      .eq('usuario_id', req.usuario_id)
      .order('fecha_programada', { ascending: false })
      .order('hora', { ascending: true });

    if (error) throw error;

    // Transformar los datos para que el frontend reciba "fecha"
    const transformedData = (data || []).map(item => ({
      ...item,
      fecha: item.fecha_programada
    }));

    res.status(200).json({
      success: true,
      data: transformedData
    });
  } catch (error) {
    console.error('❌ Error en GET /estudios:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Error al obtener los estudios'
    });
  }
});

// ==================== CREATE ESTUDIO ====================
app.post('/estudios', verifyToken, async (req, res) => {
  try {
    const { titulo, tipo, fecha, hora, lugar, notas, recordatorio } = req.body;

    if (!titulo || !tipo || !fecha) {
      return res.status(400).json({
        success: false,
        error: 'Faltan campos obligatorios: titulo, tipo, fecha'
      });
    }

    const { data, error } = await supabase
      .from('estudios')
      .insert({
        usuario_id: req.usuario_id,
        titulo,
        tipo,
        fecha_programada: fecha,
        hora: hora || null,
        lugar: lugar || '',
        notas: notas || '',
        estado: 'pendiente',
        recordatorio: recordatorio !== undefined ? recordatorio : true
      })
      .select()
      .single();

    if (error) throw error;

    // Transformar para devolver "fecha"
    const responseData = {
      ...data,
      fecha: data.fecha_programada
    };

    res.status(201).json({
      success: true,
      data: responseData,
      message: 'Estudio registrado correctamente'
    });
  } catch (error) {
    console.error('❌ Error en POST /estudios:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Error al registrar el estudio'
    });
  }
});

// ==================== GET ESTUDIO BY ID ====================
app.get('/estudios/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('estudios')
      .select('*')
      .eq('id', id)
      .eq('usuario_id', req.usuario_id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({
          success: false,
          error: 'Estudio no encontrado'
        });
      }
      throw error;
    }

    // Transformar para devolver "fecha"
    const responseData = {
      ...data,
      fecha: data.fecha_programada
    };

    res.status(200).json({
      success: true,
      data: responseData
    });
  } catch (error) {
    console.error('❌ Error en GET /estudios/:id:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Error al obtener el estudio'
    });
  }
});

// ==================== UPDATE ESTUDIO ====================
app.put('/estudios/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { titulo, tipo, fecha, hora, lugar, notas, estado, recordatorio } = req.body;

    const updateData = {};
    if (titulo !== undefined) updateData.titulo = titulo;
    if (tipo !== undefined) updateData.tipo = tipo;
    if (fecha !== undefined) updateData.fecha_programada = fecha;
    if (hora !== undefined) updateData.hora = hora;
    if (lugar !== undefined) updateData.lugar = lugar;
    if (notas !== undefined) updateData.notas = notas;
    if (estado !== undefined) updateData.estado = estado;
    if (recordatorio !== undefined) updateData.recordatorio = recordatorio;

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No hay campos para actualizar'
      });
    }

    const { data, error } = await supabase
      .from('estudios')
      .update(updateData)
      .eq('id', id)
      .eq('usuario_id', req.usuario_id)
      .select()
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({
          success: false,
          error: 'Estudio no encontrado'
        });
      }
      throw error;
    }

    // Transformar para devolver "fecha"
    const responseData = {
      ...data,
      fecha: data.fecha_programada
    };

    res.status(200).json({
      success: true,
      data: responseData,
      message: 'Estudio actualizado correctamente'
    });
  } catch (error) {
    console.error('❌ Error en PUT /estudios/:id:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Error al actualizar el estudio'
    });
  }
});

// ==================== UPDATE ESTADO ESTUDIO ====================
app.patch('/estudios/:id/estado', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { estado } = req.body;

    if (!estado) {
      return res.status(400).json({
        success: false,
        error: 'Estado es requerido'
      });
    }

    const estadosValidos = ['pendiente', 'completado', 'cancelado', 'programado'];
    if (!estadosValidos.includes(estado)) {
      return res.status(400).json({
        success: false,
        error: 'Estado inválido. Valores permitidos: pendiente, completado, cancelado, programado'
      });
    }

    const { data, error } = await supabase
      .from('estudios')
      .update({ estado })
      .eq('id', id)
      .eq('usuario_id', req.usuario_id)
      .select()
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({
          success: false,
          error: 'Estudio no encontrado'
        });
      }
      throw error;
    }

    // Transformar para devolver "fecha"
    const responseData = {
      ...data,
      fecha: data.fecha_programada
    };

    res.status(200).json({
      success: true,
      data: responseData,
      message: `Estudio ${estado} correctamente`
    });
  } catch (error) {
    console.error('❌ Error en PATCH /estudios/:id/estado:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Error al cambiar el estado del estudio'
    });
  }
});

// ==================== GET ESTUDIOS POR FECHA ====================
app.get('/estudios/fecha/:fecha', verifyToken, async (req, res) => {
  try {
    const { fecha } = req.params;

    if (!fecha) {
      return res.status(400).json({
        success: false,
        error: 'fecha es requerida'
      });
    }

    const { data, error } = await supabase
      .from('estudios')
      .select('*')
      .eq('usuario_id', req.usuario_id)
      .eq('fecha_programada', fecha)
      .order('hora', { ascending: true });

    if (error) throw error;

    // Transformar para devolver "fecha"
    const transformedData = (data || []).map(item => ({
      ...item,
      fecha: item.fecha_programada
    }));

    res.status(200).json({
      success: true,
      data: transformedData
    });
  } catch (error) {
    console.error('❌ Error en GET /estudios/fecha/:fecha:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Error al obtener los estudios por fecha'
    });
  }
});

// ==================== GET ESTUDIOS POR TIPO ====================
app.get('/estudios/tipo/:tipo', verifyToken, async (req, res) => {
  try {
    const { tipo } = req.params;

    if (!tipo) {
      return res.status(400).json({
        success: false,
        error: 'tipo es requerido'
      });
    }

    const { data, error } = await supabase
      .from('estudios')
      .select('*')
      .eq('usuario_id', req.usuario_id)
      .eq('tipo', tipo)
      .order('fecha_programada', { ascending: false });

    if (error) throw error;

    // Transformar para devolver "fecha"
    const transformedData = (data || []).map(item => ({
      ...item,
      fecha: item.fecha_programada
    }));

    res.status(200).json({
      success: true,
      data: transformedData
    });
  } catch (error) {
    console.error('❌ Error en GET /estudios/tipo/:tipo:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Error al obtener los estudios por tipo'
    });
  }
});

// ==================== START SERVER ====================
app.listen(PORT, () => {
  console.log(`✅ Estudios Service running on port ${PORT}`);
});
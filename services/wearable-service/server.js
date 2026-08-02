const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const path = require('path');  // ✅ IMPORTANTE
const supabase = require('./db');

require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const app = express();
const PORT = process.env.WEARABLE_PORT || 3006;

if (!process.env.JWT_SECRET) {
  console.error('ERROR: JWT_SECRET no definido');
  process.exit(1);
}

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

function extraerUsuarioId(req) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return null;

    const token = authHeader.split(' ')[1];
    if (!token) return null;

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    return decoded.id;
  } catch {
    return null;
  }
}

// HEALTH CHECK
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    service: 'wearable-service',
    timestamp: new Date().toISOString()
  });
});

// ==================== RESUMEN PARA WEARABLE ====================

app.get('/wearable/resumen', async (req, res) => {
  try {
    const usuarioId = extraerUsuarioId(req);
    if (!usuarioId) {
      return res.status(401).json({ success: false, error: 'Usuario no autenticado' });
    }

    const hoy = new Date().toISOString().split('T')[0];
    const manana = new Date();
    manana.setDate(manana.getDate() + 1);
    const mananaStr = manana.toISOString().split('T')[0];

    // 1. Citas de hoy y mañana
    const { data: citas } = await supabase
      .from('citas')
      .select('*')
      .eq('usuario_id', usuarioId)
      .eq('estado', 'pendiente')
      .in('fecha', [hoy, mananaStr])
      .order('fecha', { ascending: true })
      .order('hora', { ascending: true });

    // 2. Medicamentos pendientes de hoy
    const { data: tratamientos } = await supabase
      .from('tratamientos')
      .select('*, medicamentos(*)')
      .eq('usuario_id', usuarioId)
      .eq('estado', 'activo');

    const medicamentosPendientes = [];
    for (const tratamiento of (tratamientos || [])) {
      for (const med of (tratamiento.medicamentos || [])) {
        if (med.activo === false) continue;
        
        const { data: tomas } = await supabase
          .from('tomas')
          .select('*')
          .eq('medicamento_id', med.id)
          .eq('fecha', hoy)
          .eq('completado', false)
          .order('hora', { ascending: true });

        if (tomas && tomas.length > 0) {
          medicamentosPendientes.push({
            id: med.id,
            nombre: med.nombre,
            dosis: med.dosis,
            frecuencia: med.frecuencia,
            tratamiento: tratamiento.nombre,
            tomas: tomas.slice(0, 3)
          });
        }
      }
    }

    // 3. Estudios de hoy y mañana
    const { data: estudios } = await supabase
      .from('estudios')
      .select('*')
      .eq('usuario_id', usuarioId)
      .eq('estado', 'pendiente')
      .in('fecha', [hoy, mananaStr])
      .order('fecha', { ascending: true })
      .order('hora', { ascending: true });

    // 4. Estadísticas del día
    const { data: tomasHoy } = await supabase
      .from('tomas')
      .select('completado')
      .eq('usuario_id', usuarioId)
      .eq('fecha', hoy);

    const totalTomas = tomasHoy?.length || 0;
    const completadas = tomasHoy?.filter(t => t.completado).length || 0;
    const progreso = totalTomas > 0 ? Math.round((completadas / totalTomas) * 100) : 0;

    res.json({
      success: true,
      data: {
        citas: citas || [],
        medicamentos_pendientes: medicamentosPendientes || [],
        estudios: estudios || [],
        estadisticas: {
          total_tomas: totalTomas,
          completadas: completadas,
          progreso: progreso,
          fecha: hoy
        },
        ultima_actualizacion: new Date().toISOString()
      }
    });

  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== MARCAR TOMA ====================

app.post('/wearable/tomar/:medicamentoId', async (req, res) => {
  try {
    const usuarioId = extraerUsuarioId(req);
    if (!usuarioId) {
      return res.status(401).json({ success: false, error: 'Usuario no autenticado' });
    }

    const { medicamentoId } = req.params;
    const { fecha, hora } = req.body;

    if (!fecha || !hora) {
      return res.status(400).json({ success: false, error: 'Fecha y hora son requeridas' });
    }

    const { data: toma, error: findError } = await supabase
      .from('tomas')
      .select('*')
      .eq('medicamento_id', medicamentoId)
      .eq('fecha', fecha)
      .eq('hora', hora)
      .eq('usuario_id', usuarioId)
      .single();

    if (findError || !toma) {
      return res.status(404).json({ success: false, error: 'Toma no encontrada' });
    }

    if (toma.completado) {
      return res.status(400).json({ success: false, error: 'Ya fue tomada' });
    }

    const { data, error } = await supabase
      .from('tomas')
      .update({ completado: true })
      .eq('id', toma.id)
      .select()
      .single();

    if (error) {
      return res.status(500).json({ success: false, error: error.message });
    }

    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Wearable service running on port ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
});
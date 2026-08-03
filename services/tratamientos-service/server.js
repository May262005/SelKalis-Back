const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const supabase = require('./db');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const app = express();
const PORT = process.env.TRATAMIENTOS_SERVICE_PORT || 3002;

// ==================== CORS CONFIGURACIÓN ====================
const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:4200').replace(/\/$/, '');
const allowedOrigins = [frontendUrl, frontendUrl + '/'];

console.log(`CORS permitido para: ${frontendUrl}`);

app.use((req, res, next) => {
  const origin = req.headers.origin;

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

// ==================== HEALTH CHECK ====================
app.get('/health', (req, res) => {
  res.json({ status: 'OK', service: 'tratamientos-service' });
});

// ==================== ZONA HORARIA CORREGIDA ====================
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

function obtenerAhoraEnZona(timeZone) {
  const ahora = new Date();
  
  const options = {
    timeZone: timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  };
  
  const formatter = new Intl.DateTimeFormat('en-US', options);
  const parts = formatter.formatToParts(ahora);
  
  let year = '', month = '', day = '', hour = '', minute = '';
  
  parts.forEach(p => {
    if (p.type === 'year') year = p.value;
    if (p.type === 'month') month = p.value;
    if (p.type === 'day') day = p.value;
    if (p.type === 'hour') hour = p.value;
    if (p.type === 'minute') minute = p.value;
  });
  
  if (hour === '24') hour = '00';
  
  const fecha = `${year}-${month}-${day}`;
  const hora = `${hour}:${minute}`;
  
  return { fecha, hora };
}

function crearFechaLocal(fechaStr, horaStr, timezone) {
  if (!timezone || timezone === 'UTC') {
    const [y, m, d] = fechaStr.split('-').map(Number);
    const [h, min] = horaStr.split(':').map(Number);
    return new Date(Date.UTC(y, m - 1, d, h, min));
  }
  
  const fechaCompleta = `${fechaStr}T${horaStr}:00`;
  const date = new Date(fechaCompleta);
  
  const userDate = new Date(date.toLocaleString('en-US', { timeZone: timezone }));
  const userOffset = userDate.getTimezoneOffset();
  const currentOffset = date.getTimezoneOffset();
  const diffMinutes = userOffset - currentOffset;
  date.setMinutes(date.getMinutes() + diffMinutes);
  
  return date;
}

function formatearFecha(date) {
  const y = date.getFullYear();
  const m = (date.getMonth() + 1).toString().padStart(2, '0');
  const d = date.getDate().toString().padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatearHora(date) {
  return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
}

function obtenerIntervaloHoras(frecuencia) {
  const mapa = {
    'Cada 4 horas': 4,
    'Cada 6 horas': 6,
    'Cada 8 horas': 8,
    'Cada 12 horas': 12,
    'Una vez al día': 24
  };
  return mapa[frecuencia] || null;
}

function generarTomas(fechaInicio, duracionDias, frecuencia, horaInicio) {
  if (frecuencia === 'Según necesidad') return [];
  const intervalo = obtenerIntervaloHoras(frecuencia);
  if (!intervalo) return [];

  const [h, m] = (horaInicio || '08:00').split(':').map(Number);
  const actual = new Date(fechaInicio + 'T00:00:00');
  actual.setHours(h, m || 0, 0, 0);

  const ventanaFin = new Date(fechaInicio + 'T00:00:00');
  ventanaFin.setDate(ventanaFin.getDate() + duracionDias);

  const tomas = [];
  let cursor = new Date(actual);

  while (cursor < ventanaFin) {
    tomas.push({
      fecha: formatearFecha(cursor),
      hora: formatearHora(cursor),
      completado: false
    });
    cursor = new Date(cursor.getTime() + intervalo * 60 * 60 * 1000);
  }
  return tomas;
}

async function recalcularFechaFinTratamiento(tratamientoId, supabaseClient) {
  const { data: medicamentos, error } = await supabaseClient
    .from('medicamentos')
    .select('duracion_dias, created_at')
    .eq('tratamiento_id', tratamientoId)
    .eq('activo', true);

  if (error) throw error;
  if (!medicamentos || medicamentos.length === 0) {
    const hoy = new Date().toISOString().split('T')[0];
    const { error: updateError } = await supabaseClient
      .from('tratamientos')
      .update({ fecha_fin: hoy })
      .eq('id', tratamientoId);
    if (updateError) throw updateError;
    return hoy;
  }

  let fechaFinMax = null;
  for (const med of medicamentos) {
    const fechaInicio = med.created_at?.split('T')[0] || new Date().toISOString().split('T')[0];
    const fechaFinMed = new Date(fechaInicio + 'T00:00:00');
    fechaFinMed.setDate(fechaFinMed.getDate() + med.duracion_dias - 1);
    const fechaStr = fechaFinMed.toISOString().split('T')[0];

    if (!fechaFinMax || fechaStr > fechaFinMax) {
      fechaFinMax = fechaStr;
    }
  }

  if (!fechaFinMax) {
    const hoy = new Date().toISOString().split('T')[0];
    fechaFinMax = hoy;
  }

  const { error: updateError } = await supabaseClient
    .from('tratamientos')
    .update({ fecha_fin: fechaFinMax })
    .eq('id', tratamientoId);

  if (updateError) throw updateError;
  return fechaFinMax;
}

// ==================== TRATAMIENTOS ENDPOINTS ====================

app.get('/tratamientos', verifyToken, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('tratamientos')
      .select(`*, medicamentos (*)`)
      .eq('usuario_id', req.usuario_id)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/tratamientos/:id', verifyToken, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('tratamientos')
      .select(`*, medicamentos (*)`)
      .eq('id', req.params.id)
      .eq('usuario_id', req.usuario_id)
      .single();

    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/tratamientos', verifyToken, async (req, res) => {
  try {
    const { nombre, diagnostico, fechaInicio, notas, medicamentos } = req.body;
    const timezone = obtenerTimezone(req);
    const { fecha: hoyUsuarioStr } = obtenerAhoraEnZona(timezone);

    if (fechaInicio < hoyUsuarioStr) {
      return res.status(400).json({
        success: false,
        error: 'La fecha de inicio no puede ser un día que ya pasó'
      });
    }

    let fechaFin = new Date(fechaInicio + 'T00:00:00');
    if (medicamentos && medicamentos.length > 0) {
      const duracionMaxima = Math.max(...medicamentos.map(m => m.duracionDias));
      fechaFin.setDate(fechaFin.getDate() + duracionMaxima - 1);
    }

    const { data: tratamientoData, error: tratamientoError } = await supabase
      .from('tratamientos')
      .insert([{
        usuario_id: req.usuario_id,
        nombre,
        diagnostico: diagnostico || null,
        fecha_inicio: fechaInicio,
        fecha_fin: fechaFin.toISOString().split('T')[0],
        notas: notas || null,
        estado: 'activo',
        historial_ajustes: []
      }])
      .select()
      .single();

    if (tratamientoError) throw tratamientoError;

    if (medicamentos && medicamentos.length > 0) {
      for (const med of medicamentos) {
        const tomas = generarTomas(fechaInicio, med.duracionDias, med.frecuencia, med.horaInicio);
        const { error: medError } = await supabase
          .from('medicamentos')
          .insert([{
            tratamiento_id: tratamientoData.id,
            nombre: med.nombre,
            concentracion: med.concentracion || null,
            dosis: med.dosis || null,
            frecuencia: med.frecuencia,
            hora_inicio: med.horaInicio,
            duracion_dias: med.duracionDias,
            instrucciones: med.instrucciones || null,
            tomas: tomas,
            historial_ajustes: []
          }]);
        if (medError) throw medError;
      }

      await recalcularFechaFinTratamiento(tratamientoData.id, supabase);
    }

    const { data: tratamientoCompleto, error: getError } = await supabase
      .from('tratamientos')
      .select(`*, medicamentos (*)`)
      .eq('id', tratamientoData.id)
      .single();

    if (getError) throw getError;
    res.json({ success: true, data: tratamientoCompleto });
  } catch (error) {
    console.error('Error en POST /tratamientos:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.put('/tratamientos/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { nombre, diagnostico, notas } = req.body;

    if (!nombre) {
      return res.status(400).json({
        success: false,
        error: 'El nombre del tratamiento es obligatorio'
      });
    }

    const updateData = {
      nombre,
      diagnostico: diagnostico || null,
      notas: notas || null,
      updated_at: new Date().toISOString()
    };

    const { data, error } = await supabase
      .from('tratamientos')
      .update(updateData)
      .eq('id', id)
      .eq('usuario_id', req.usuario_id)
      .select()
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({
          success: false,
          error: 'Tratamiento no encontrado'
        });
      }
      throw error;
    }

    res.status(200).json({
      success: true,
      data,
      message: 'Tratamiento actualizado correctamente'
    });
  } catch (error) {
    console.error('Error en PUT /tratamientos/:id:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Error al actualizar el tratamiento'
    });
  }
});

app.patch('/tratamientos/:id/estado', verifyToken, async (req, res) => {
  try {
    const { activo, razon } = req.body;
    const timezone = obtenerTimezone(req);
    const { fecha: hoyStr } = obtenerAhoraEnZona(timezone);

    const { data: tratamiento, error: getError } = await supabase
      .from('tratamientos')
      .select('historial_ajustes, estado')
      .eq('id', req.params.id)
      .eq('usuario_id', req.usuario_id)
      .single();

    if (getError) throw getError;

    if (activo === false) {
      await supabase
        .from('medicamentos')
        .update({
          activo: false,
          fecha_suspension: hoyStr
        })
        .eq('tratamiento_id', req.params.id);
    } else {
      await supabase
        .from('medicamentos')
        .update({
          activo: true,
          fecha_suspension: null
        })
        .eq('tratamiento_id', req.params.id);

      await recalcularFechaFinTratamiento(req.params.id, supabase);
    }

    const historial = tratamiento.historial_ajustes || [];
    historial.push({
      fecha: hoyStr,
      tipo: activo ? 'reactivar' : 'suspender',
      razon: razon || (activo ? 'Reactivación del tratamiento' : 'Suspensión del tratamiento')
    });

    const { error } = await supabase
      .from('tratamientos')
      .update({
        activo,
        historial_ajustes: historial,
        ultimo_ajuste: hoyStr
      })
      .eq('id', req.params.id)
      .eq('usuario_id', req.usuario_id);

    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    console.error('Error en PATCH /tratamientos/:id/estado:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== MEDICAMENTOS ENDPOINTS ====================

app.post('/tratamientos/:tratamientoId/medicamentos', verifyToken, async (req, res) => {
  try {
    const { nombre, concentracion, dosis, frecuencia, horaInicio, duracionDias, instrucciones } = req.body;

    const { data: tratamiento, error: tratError } = await supabase
      .from('tratamientos')
      .select('id, fecha_inicio')
      .eq('id', req.params.tratamientoId)
      .eq('usuario_id', req.usuario_id)
      .single();

    if (tratError) throw tratError;

    const tomas = generarTomas(tratamiento.fecha_inicio, duracionDias, frecuencia, horaInicio);

    const { data: medData, error: medError } = await supabase
      .from('medicamentos')
      .insert([{
        tratamiento_id: req.params.tratamientoId,
        nombre,
        concentracion: concentracion || null,
        dosis: dosis || null,
        frecuencia,
        hora_inicio: horaInicio,
        duracion_dias: duracionDias,
        instrucciones: instrucciones || null,
        tomas: tomas,
        historial_ajustes: []
      }])
      .select()
      .single();

    if (medError) throw medError;

    await recalcularFechaFinTratamiento(req.params.tratamientoId, supabase);

    res.json({ success: true, data: medData });
  } catch (error) {
    console.error('Error en POST /tratamientos/:tratamientoId/medicamentos:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.put('/medicamentos/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { nombre, concentracion, dosis, frecuencia, hora_inicio, duracion_dias, instrucciones } = req.body;

    if (!nombre) {
      return res.status(400).json({
        success: false,
        error: 'El nombre del medicamento es obligatorio'
      });
    }

    const updateData = {
      nombre,
      concentracion: concentracion || null,
      dosis: dosis || null,
      frecuencia,
      hora_inicio: hora_inicio,
      duracion_dias: duracion_dias,
      instrucciones: instrucciones || null
    };

    const timezone = obtenerTimezone(req);
    const { fecha: hoyStr } = obtenerAhoraEnZona(timezone);

    const { data: medActual, error: getError } = await supabase
      .from('medicamentos')
      .select('*')
      .eq('id', id)
      .single();

    if (getError) throw getError;

    if (medActual.activo === false) {
      return res.status(400).json({
        success: false,
        error: 'No se puede editar un medicamento suspendido. Reactívalo primero.'
      });
    }

    const frecuenciaCambio = medActual.frecuencia !== frecuencia;
    const duracionCambio = medActual.duracion_dias !== duracion_dias;

    let tomasFinal = medActual.tomas || [];

    if (frecuenciaCambio || duracionCambio) {
      const tomasPasadas = tomasFinal.filter((t) => t.fecha < hoyStr);
      const completadasHoy = tomasFinal.filter((t) => t.fecha === hoyStr && t.completado === true);

      const nuevasTomas = generarTomas(
        hoyStr,
        duracion_dias || medActual.duracion_dias,
        frecuencia,
        hora_inicio || medActual.hora_inicio
      );

      tomasFinal = [...tomasPasadas, ...completadasHoy];
      for (const toma of nuevasTomas) {
        const existe = tomasFinal.some((t) => t.fecha === toma.fecha && t.hora === toma.hora);
        if (!existe) {
          tomasFinal.push(toma);
        }
      }
    }

    let historial = medActual.historial_ajustes || [];
    if (frecuenciaCambio || duracionCambio || medActual.nombre !== nombre) {
      historial.push({
        fecha: hoyStr,
        tipo: 'actualizar_datos',
        razon: 'Actualización de datos del medicamento',
        frecuenciaAnterior: frecuenciaCambio ? medActual.frecuencia : null,
        frecuenciaNueva: frecuenciaCambio ? frecuencia : null,
        nuevaDuracion: duracionCambio ? duracion_dias : null
      });
    }

    const { data, error } = await supabase
      .from('medicamentos')
      .update({
        ...updateData,
        tomas: tomasFinal,
        historial_ajustes: historial,
        ultimo_ajuste: hoyStr
      })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({
          success: false,
          error: 'Medicamento no encontrado'
        });
      }
      throw error;
    }

    if (duracionCambio) {
      await recalcularFechaFinTratamiento(medActual.tratamiento_id, supabase);
    }

    res.status(200).json({
      success: true,
      data,
      message: 'Medicamento actualizado correctamente'
    });
  } catch (error) {
    console.error('Error en PUT /medicamentos/:id:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Error al actualizar el medicamento'
    });
  }
});

app.patch('/medicamentos/:id/extender', verifyToken, async (req, res) => {
  try {
    const { diasExtra, razon } = req.body;
    const timezone = obtenerTimezone(req);
    const { fecha: hoyStr } = obtenerAhoraEnZona(timezone);

    if (!diasExtra || diasExtra < 1) {
      return res.status(400).json({
        success: false,
        error: 'Los días extra deben ser al menos 1'
      });
    }

    const { data: medicamento, error: getError } = await supabase
      .from('medicamentos')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (getError) throw getError;
    if (medicamento.activo === false) {
      return res.status(400).json({
        success: false,
        error: 'No se puede extender un medicamento suspendido'
      });
    }

    const nuevasTomas = generarTomas(
      hoyStr,
      medicamento.duracion_dias + diasExtra,
      medicamento.frecuencia,
      medicamento.hora_inicio
    );

    const tomasExistentes = medicamento.tomas || [];
    const tomasFinal = [...tomasExistentes];

    for (const toma of nuevasTomas) {
      const existe = tomasFinal.some(t => t.fecha === toma.fecha && t.hora === toma.hora);
      if (!existe) {
        tomasFinal.push(toma);
      }
    }

    const historial = medicamento.historial_ajustes || [];
    historial.push({
      fecha: hoyStr,
      tipo: 'extender',
      razon: razon || 'Extensión de tratamiento indicada por médico',
      diasExtra: diasExtra,
      nuevaDuracion: medicamento.duracion_dias + diasExtra
    });

    const { data, error } = await supabase
      .from('medicamentos')
      .update({
        duracion_dias: medicamento.duracion_dias + diasExtra,
        tomas: tomasFinal,
        historial_ajustes: historial,
        ultimo_ajuste: hoyStr
      })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;

    await recalcularFechaFinTratamiento(medicamento.tratamiento_id, supabase);

    res.json({ success: true, data });
  } catch (error) {
    console.error('Error extendiendo medicamento:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.patch('/medicamentos/:id/cambiar-frecuencia', verifyToken, async (req, res) => {
  try {
    const { nuevaFrecuencia, razon } = req.body;
    const timezone = obtenerTimezone(req);
    const { fecha: hoyStr } = obtenerAhoraEnZona(timezone);

    const frecuenciasValidas = ['Cada 4 horas', 'Cada 6 horas', 'Cada 8 horas', 'Cada 12 horas', 'Una vez al día', 'Según necesidad'];
    if (!frecuenciasValidas.includes(nuevaFrecuencia)) {
      return res.status(400).json({
        success: false,
        error: 'Frecuencia no válida'
      });
    }

    const { data: medicamento, error: getError } = await supabase
      .from('medicamentos')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (getError) throw getError;
    if (medicamento.activo === false) {
      return res.status(400).json({
        success: false,
        error: 'No se puede modificar un medicamento suspendido'
      });
    }

    const tomasPasadas = (medicamento.tomas || []).filter(t => t.fecha < hoyStr);
    const completadasHoy = (medicamento.tomas || []).filter(t => t.fecha === hoyStr && t.completado === true);

    const nuevasTomas = generarTomas(
      hoyStr,
      medicamento.duracion_dias,
      nuevaFrecuencia,
      medicamento.hora_inicio
    );

    const tomasFinal = [...tomasPasadas, ...completadasHoy];
    for (const toma of nuevasTomas) {
      const existe = tomasFinal.some(t => t.fecha === toma.fecha && t.hora === toma.hora);
      if (!existe) {
        tomasFinal.push(toma);
      }
    }

    const historial = medicamento.historial_ajustes || [];
    historial.push({
      fecha: hoyStr,
      tipo: 'cambiar_frecuencia',
      razon: razon || 'Cambio de frecuencia indicado por médico',
      frecuenciaAnterior: medicamento.frecuencia,
      frecuenciaNueva: nuevaFrecuencia
    });

    const { data, error } = await supabase
      .from('medicamentos')
      .update({
        frecuencia: nuevaFrecuencia,
        tomas: tomasFinal,
        historial_ajustes: historial,
        ultimo_ajuste: hoyStr
      })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;

    await recalcularFechaFinTratamiento(medicamento.tratamiento_id, supabase);

    res.json({ success: true, data });
  } catch (error) {
    console.error('Error cambiando frecuencia:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.patch('/medicamentos/:id/suspender', verifyToken, async (req, res) => {
  try {
    const { razon } = req.body;
    const timezone = obtenerTimezone(req);
    const { fecha: hoyStr } = obtenerAhoraEnZona(timezone);

    const { data: medicamento, error: getError } = await supabase
      .from('medicamentos')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (getError) throw getError;
    if (medicamento.activo === false) {
      return res.status(400).json({
        success: false,
        error: 'El medicamento ya está suspendido'
      });
    }

    const tomasFinal = medicamento.tomas || [];

    const historial = medicamento.historial_ajustes || [];
    historial.push({
      fecha: hoyStr,
      tipo: 'suspender',
      razon: razon || 'Suspensión indicada por médico'
    });

    const { data, error } = await supabase
      .from('medicamentos')
      .update({
        activo: false,
        fecha_suspension: hoyStr,
        tomas: tomasFinal,
        historial_ajustes: historial,
        ultimo_ajuste: hoyStr
      })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;

    await recalcularFechaFinTratamiento(medicamento.tratamiento_id, supabase);

    res.json({ success: true, data });
  } catch (error) {
    console.error('Error suspendiendo medicamento:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.patch('/medicamentos/:id/reactivar', verifyToken, async (req, res) => {
  try {
    const { razon } = req.body;
    const timezone = obtenerTimezone(req);
    const { fecha: hoyStr } = obtenerAhoraEnZona(timezone);

    const { data: medicamento, error: getError } = await supabase
      .from('medicamentos')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (getError) throw getError;
    if (medicamento.activo === true) {
      return res.status(400).json({
        success: false,
        error: 'El medicamento ya está activo'
      });
    }

    const historial = medicamento.historial_ajustes || [];
    historial.push({
      fecha: hoyStr,
      tipo: 'reactivar',
      razon: razon || 'Reactivación indicada por médico'
    });

    const { data, error } = await supabase
      .from('medicamentos')
      .update({
        activo: true,
        fecha_suspension: null,
        historial_ajustes: historial,
        ultimo_ajuste: hoyStr
      })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;

    await recalcularFechaFinTratamiento(medicamento.tratamiento_id, supabase);

    res.json({ success: true, data });
  } catch (error) {
    console.error('Error reactivando medicamento:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== ENDPOINT: TOMAS DEL DÍA CORREGIDO ====================
app.get('/tomas/hoy', verifyToken, async (req, res) => {
  try {
    const timezone = obtenerTimezone(req);
    const { fecha: hoyStr } = obtenerAhoraEnZona(timezone);
    
    console.log(`📅 Buscando tomas para: ${hoyStr} (zona: ${timezone})`);
    
    const { data: tratamientos, error } = await supabase
      .from('tratamientos')
      .select(`*, medicamentos (*)`)
      .eq('usuario_id', req.usuario_id)
      .eq('activo', true);

    if (error) throw error;

    let totalTomasHoy = 0;
    let completadasHoy = 0;
    const tomasPorMedicamento = [];

    for (const tratamiento of tratamientos || []) {
      const medicamentos = tratamiento.medicamentos || [];
      for (const med of medicamentos) {
        if (med.activo === false) continue;
        
        const tomas = med.tomas || [];
        const tomasDeHoy = tomas.filter((t) => t.fecha === hoyStr);
        const completadasDeHoy = tomasDeHoy.filter((t) => t.completado === true);
        
        console.log(`💊 ${med.nombre}: ${tomasDeHoy.length} tomas hoy, ${completadasDeHoy.length} completadas`);
        
        totalTomasHoy += tomasDeHoy.length;
        completadasHoy += completadasDeHoy.length;
        
        if (tomasDeHoy.length > 0) {
          tomasPorMedicamento.push({
            medicamentoId: med.id,
            nombre: med.nombre,
            tomas: tomasDeHoy,
            completadas: completadasDeHoy.length,
            total: tomasDeHoy.length
          });
        }
      }
    }

    console.log(`📊 Total: ${totalTomasHoy} tomas, ${completadasHoy} completadas`);

    res.json({
      success: true,
      data: {
        fecha: hoyStr,
        totalTomasHoy,
        completadasHoy,
        progresoHoy: totalTomasHoy > 0 ? Math.round((completadasHoy / totalTomasHoy) * 100) : 0,
        tomasPorMedicamento
      }
    });
  } catch (error) {
    console.error('Error en GET /tomas/hoy:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== TOMAS ENDPOINT CORREGIDO ====================
app.post('/medicamentos/:medicamentoId/tomas', verifyToken, async (req, res) => {
  try {
    const { fecha, hora, completado } = req.body;
    const MARGEN_TOMA_MINUTOS = 30;

    if (completado === false) {
      return res.status(400).json({
        success: false,
        error: 'No se puede desmarcar una toma una vez registrada como tomada'
      });
    }

    const timezone = obtenerTimezone(req);
    const { fecha: hoyStr, hora: horaActualStr } = obtenerAhoraEnZona(timezone);

    console.log(`🕐 Fecha programada: ${fecha} ${hora}`);
    console.log(`🕐 Fecha actual: ${hoyStr} ${horaActualStr}`);
    console.log(`🕐 Zona horaria: ${timezone}`);

    const fechaProgramada = crearFechaLocal(fecha, hora, timezone);
    const fechaActual = crearFechaLocal(hoyStr, horaActualStr, timezone);
    
    const diferenciaMinutos = (fechaActual.getTime() - fechaProgramada.getTime()) / 60000;
    
    console.log(`⏱️ Diferencia: ${diferenciaMinutos} minutos`);

    if (diferenciaMinutos < 0) {
      return res.status(400).json({
        success: false,
        error: 'Todavía no es hora de tomar esta dosis'
      });
    }
    if (diferenciaMinutos > MARGEN_TOMA_MINUTOS) {
      return res.status(400).json({
        success: false,
        error: `Ya pasó el margen de ${MARGEN_TOMA_MINUTOS} minutos para registrar esta toma`
      });
    }

    const { data: medicamento, error: getError } = await supabase
      .from('medicamentos')
      .select('tomas, activo')
      .eq('id', req.params.medicamentoId)
      .single();

    if (getError) throw getError;

    if (medicamento.activo === false) {
      return res.status(400).json({
        success: false,
        error: 'No se puede registrar tomas de un medicamento suspendido'
      });
    }

    let tomas = medicamento.tomas || [];
    let tomaEncontrada = false;

    tomas = tomas.map(toma => {
      if (toma.fecha === fecha && toma.hora === hora) {
        tomaEncontrada = true;
        if (toma.completado === true) {
          return toma;
        }
        return { ...toma, completado: true };
      }
      return toma;
    });

    if (!tomaEncontrada) {
      tomas.push({ fecha, hora, completado: true });
    }

    const { data, error } = await supabase
      .from('medicamentos')
      .update({ tomas: tomas })
      .eq('id', req.params.medicamentoId)
      .select();

    if (error) throw error;
    
    console.log(`✅ Toma registrada: ${fecha} ${hora}`);
    
    res.json({ success: true, data: data && data.length > 0 ? data[0] : null });
  } catch (error) {
    console.error('Error marcando toma:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/medicamentos/:medicamentoId/tomas/:fecha', verifyToken, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('medicamentos')
      .select('tomas')
      .eq('id', req.params.medicamentoId)
      .maybeSingle();

    if (error) throw error;
    const tomas = data?.tomas || [];
    const tomasFiltradas = tomas.filter(t => t.fecha === req.params.fecha);
    res.json({ success: true, data: tomasFiltradas });
  } catch (error) {
    console.error('Error obteniendo tomas:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/medicamentos/:id/historial', verifyToken, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('medicamentos')
      .select('historial_ajustes, nombre')
      .eq('id', req.params.id)
      .single();

    if (error) throw error;
    res.json({ success: true, data: data.historial_ajustes || [] });
  } catch (error) {
    console.error('Error obteniendo historial:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Tratamientos Service running on port ${PORT}`);
  console.log(`CORS permitido para: ${frontendUrl}`);
});

module.exports = app;
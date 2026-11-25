require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const supabase = require('./db');

if (!process.env.JWT_SECRET) {
  throw new Error('Falta la variable de entorno JWT_SECRET');
}

const app = express();
const PORT = process.env.PORT || 3010;
const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:4200').replace(/\/$/, '');
const ticketStatuses = ['abierto', 'en_proceso', 'resuelto', 'cerrado'];
const ticketCategories = ['tecnica'];

app.use(cors({ origin: frontendUrl, credentials: true }));
app.use(express.json({ limit: '20kb' }));

function authenticate(req, res, next) {
  const token = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice(7)
    : null;

  if (!token) {
    return res.status(401).json({ success: false, error: 'Token no proporcionado' });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (error) {
    console.warn('JWT rechazado por soporte:', error.name);
    return res.status(401).json({ success: false, error: 'Token inválido o expirado' });
  }

  if (!decoded.id) {
    return res.status(401).json({ success: false, error: 'Token sin usuario válido' });
  }

  return supabase
    .from('usuarios')
    .select('id, nombre, apellido, email, rol, activo')
    .eq('id', decoded.id)
    .single()
    .then(({ data: user, error }) => {
      if (error && error.code !== 'PGRST116') {
        console.error('Error consultando usuario en Supabase:', error);
        return res.status(500).json({ success: false, error: 'No se pudo validar el usuario en la base de datos' });
      }
      if (!user) {
        return res.status(401).json({ success: false, error: 'Usuario no encontrado' });
      }
      if (user.activo === false) {
        return res.status(403).json({ success: false, error: 'Usuario desactivado' });
      }

      req.user = user;
      return next();
    })
    .catch(error => {
      console.error('Error verificando usuario:', error);
      return res.status(500).json({ success: false, error: 'No se pudo validar la sesión' });
    });
}

function requireAdmin(req, res, next) {
  if (req.user?.rol !== 'admin') {
    return res.status(403).json({ success: false, error: 'Se requiere una cuenta de administrador' });
  }
  return next();
}

function readMessage(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function requesterName(user) {
  return [user.nombre, user.apellido].filter(Boolean).join(' ').trim() || user.email;
}

async function getConversationForUser(user) {
  const { data, error } = await supabase
    .from('support_conversations')
    .upsert({
      usuario_id: user.id,
      nombre: requesterName(user),
      email: user.email
    }, { onConflict: 'usuario_id' })
    .select('id')
    .single();

  if (error) throw error;
  return data;
}

async function findTicket(ticketId) {
  const { data, error } = await supabase
    .from('support_tickets')
    .select('*')
    .eq('id', ticketId)
    .single();

  if (error) throw error;
  return data;
}

async function canReadTicket(ticketId, user) {
  const ticket = await findTicket(ticketId);
  if (user.rol !== 'admin' && ticket.usuario_id !== user.id) return null;
  return ticket;
}

app.get('/health', (req, res) => {
  res.json({ status: 'OK', service: 'soporte-service' });
});

app.get('/chat/mensajes', authenticate, async (req, res) => {
  try {
    const conversation = await getConversationForUser(req.user);
    const { data, error } = await supabase
      .from('support_chat_messages')
      .select('*')
      .eq('conversation_id', conversation.id)
      .order('created_at', { ascending: true });

    if (error) throw error;
    return res.json({ success: true, data });
  } catch (error) {
    console.error('Error en GET /chat/mensajes:', error);
    return res.status(500).json({ success: false, error: 'No se pudieron cargar los mensajes' });
  }
});

app.post('/chat/mensajes', authenticate, async (req, res) => {
  const mensaje = readMessage(req.body?.mensaje);
  if (!mensaje || mensaje.length > 1000) {
    return res.status(400).json({ success: false, error: 'El mensaje debe tener entre 1 y 1000 caracteres' });
  }

  try {
    const conversation = await getConversationForUser(req.user);
    const { data, error } = await supabase
      .from('support_chat_messages')
      .insert({
        conversation_id: conversation.id,
        sender_id: req.user.id,
        sender_role: 'user',
        mensaje
      })
      .select('*')
      .single();

    if (error) throw error;
    const { error: updateError } = await supabase
      .from('support_conversations')
      .update({ ultimo_mensaje: mensaje, updated_at: new Date().toISOString() })
      .eq('id', conversation.id);
    if (updateError) throw updateError;

    return res.status(201).json({ success: true, data });
  } catch (error) {
    console.error('Error en POST /chat/mensajes:', error);
    return res.status(500).json({ success: false, error: 'No se pudo enviar el mensaje' });
  }
});

app.get('/admin/conversaciones', authenticate, requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('support_conversations')
      .select('id, usuario_id, nombre, email, ultimo_mensaje, updated_at')
      .order('updated_at', { ascending: false });

    if (error) throw error;
    return res.json({ success: true, data });
  } catch (error) {
    console.error('Error en GET /admin/conversaciones:', error);
    return res.status(500).json({ success: false, error: 'No se pudieron cargar las conversaciones' });
  }
});

app.get('/admin/conversaciones/:id/mensajes', authenticate, requireAdmin, async (req, res) => {
  try {
    const { data: conversation, error: conversationError } = await supabase
      .from('support_conversations')
      .select('id')
      .eq('id', req.params.id)
      .single();
    if (conversationError || !conversation) {
      return res.status(404).json({ success: false, error: 'Conversación no encontrada' });
    }

    const { data, error } = await supabase
      .from('support_chat_messages')
      .select('*')
      .eq('conversation_id', conversation.id)
      .order('created_at', { ascending: true });

    if (error) throw error;
    return res.json({ success: true, data });
  } catch (error) {
    console.error('Error en GET /admin/conversaciones/:id/mensajes:', error);
    return res.status(500).json({ success: false, error: 'No se pudieron cargar los mensajes' });
  }
});

app.post('/admin/conversaciones/:id/mensajes', authenticate, requireAdmin, async (req, res) => {
  const mensaje = readMessage(req.body?.mensaje);
  if (!mensaje || mensaje.length > 1000) {
    return res.status(400).json({ success: false, error: 'El mensaje debe tener entre 1 y 1000 caracteres' });
  }

  try {
    const { data: conversation, error: conversationError } = await supabase
      .from('support_conversations')
      .select('id')
      .eq('id', req.params.id)
      .single();
    if (conversationError || !conversation) {
      return res.status(404).json({ success: false, error: 'Conversación no encontrada' });
    }

    const { data, error } = await supabase
      .from('support_chat_messages')
      .insert({
        conversation_id: conversation.id,
        sender_id: req.user.id,
        sender_role: 'admin',
        mensaje
      })
      .select('*')
      .single();

    if (error) throw error;
    const { error: updateError } = await supabase
      .from('support_conversations')
      .update({ ultimo_mensaje: mensaje, updated_at: new Date().toISOString() })
      .eq('id', conversation.id);
    if (updateError) throw updateError;

    return res.status(201).json({ success: true, data });
  } catch (error) {
    console.error('Error en POST /admin/conversaciones/:id/mensajes:', error);
    return res.status(500).json({ success: false, error: 'No se pudo enviar el mensaje' });
  }
});

app.get('/tickets', authenticate, async (req, res) => {
  try {
    let query = supabase.from('support_tickets').select('*');
    if (req.user.rol !== 'admin') query = query.eq('usuario_id', req.user.id);

    const { data, error } = await query.order('created_at', { ascending: false });
    if (error) throw error;
    return res.json({ success: true, data });
  } catch (error) {
    console.error('Error en GET /tickets:', error);
    return res.status(500).json({ success: false, error: 'No se pudieron cargar los reportes' });
  }
});

app.post('/tickets', authenticate, async (req, res) => {
  const asunto = readMessage(req.body?.asunto);
  const descripcion = readMessage(req.body?.descripcion);
  const categoria = req.body?.categoria;

  if (!asunto || asunto.length > 120 || descripcion.length < 15 || descripcion.length > 2000) {
    return res.status(400).json({ success: false, error: 'Revisa el asunto y describe el problema (15 a 2000 caracteres)' });
  }
  if (!ticketCategories.includes(categoria)) {
    return res.status(400).json({ success: false, error: 'Categoría de incidencia no válida' });
  }

  try {
    const { data, error } = await supabase
      .from('support_tickets')
      .insert({
        usuario_id: req.user.id,
        nombre_solicitante: requesterName(req.user),
        email_solicitante: req.user.email,
        asunto,
        categoria,
        descripcion
      })
      .select('*')
      .single();

    if (error) throw error;
    return res.status(201).json({ success: true, data });
  } catch (error) {
    console.error('Error en POST /tickets:', error);
    return res.status(500).json({ success: false, error: 'No se pudo registrar la incidencia' });
  }
});

app.patch('/tickets/:id', authenticate, requireAdmin, async (req, res) => {
  const estado = req.body?.estado;
  if (!ticketStatuses.includes(estado)) {
    return res.status(400).json({ success: false, error: 'Estado de incidencia no válido' });
  }

  try {
    const { data, error } = await supabase
      .from('support_tickets')
      .update({ estado, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select('*')
      .single();

    if (error) throw error;
    return res.json({ success: true, data });
  } catch (error) {
    console.error('Error en PATCH /tickets/:id:', error);
    return res.status(500).json({ success: false, error: 'No se pudo actualizar la incidencia' });
  }
});

app.get('/tickets/:id/respuestas', authenticate, async (req, res) => {
  try {
    const ticket = await canReadTicket(req.params.id, req.user);
    if (!ticket) {
      return res.status(403).json({ success: false, error: 'No tienes permiso para consultar esta incidencia' });
    }

    const { data, error } = await supabase
      .from('support_ticket_replies')
      .select('*')
      .eq('ticket_id', ticket.id)
      .order('created_at', { ascending: true });

    if (error) throw error;
    return res.json({ success: true, data });
  } catch (error) {
    console.error('Error en GET /tickets/:id/respuestas:', error);
    return res.status(500).json({ success: false, error: 'No se pudieron cargar las respuestas' });
  }
});

app.post('/tickets/:id/respuestas', authenticate, async (req, res) => {
  const mensaje = readMessage(req.body?.mensaje);
  if (!mensaje || mensaje.length > 1000) {
    return res.status(400).json({ success: false, error: 'La respuesta debe tener entre 1 y 1000 caracteres' });
  }

  try {
    const ticket = await canReadTicket(req.params.id, req.user);
    if (!ticket) {
      return res.status(403).json({ success: false, error: 'No tienes permiso para responder esta incidencia' });
    }

    const { data, error } = await supabase
      .from('support_ticket_replies')
      .insert({
        ticket_id: ticket.id,
        sender_id: req.user.id,
        sender_role: req.user.rol === 'admin' ? 'admin' : 'user',
        mensaje
      })
      .select('*')
      .single();

    if (error) throw error;
    return res.status(201).json({ success: true, data });
  } catch (error) {
    console.error('Error en POST /tickets/:id/respuestas:', error);
    return res.status(500).json({ success: false, error: 'No se pudo enviar la respuesta' });
  }
});

app.listen(PORT, () => {
  console.log(`Soporte Service running on port ${PORT}`);
  console.log(`CORS permitido para: ${frontendUrl}`);
});

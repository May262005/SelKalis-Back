const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');
const sgMail = require('@sendgrid/mail');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '../../.env') });

// ==================== VALIDACIÓN DE VARIABLES ====================
if (!process.env.SUPABASE_URL) {
  console.error('ERROR: SUPABASE_URL no está definido en .env');
  process.exit(1);
}
if (!process.env.SUPABASE_ANON_KEY) {
  console.error('ERROR: SUPABASE_ANON_KEY no está definido en .env');
  process.exit(1);
}
if (!process.env.JWT_SECRET) {
  console.error('ERROR: JWT_SECRET no está definido en .env');
  process.exit(1);
}
if (!process.env.SENDGRID_API_KEY) {
  console.error('ERROR: SENDGRID_API_KEY no está definido en .env');
  console.error('⚠️  Ve a https://signup.sendgrid.com y crea una API Key');
  process.exit(1);
}

// ==================== CONFIGURACIÓN DE SUPABASE ====================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// ==================== CONFIGURACIÓN DE SENDGRID ====================
sgMail.setApiKey(process.env.SENDGRID_API_KEY);
const FROM_EMAIL = process.env.EMAIL_USER || 'selkalis26@gmail.com';

const app = express();
const PORT = process.env.USER_SERVICE_PORT || 3001;

// ==================== CORS CONFIGURACIÓN ====================
const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:4200';

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', frontendUrl);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Max-Age', '86400');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  next();
});

app.use(express.json());

// ==================== FUNCIONES AUXILIARES ====================
function generarCodigo() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// ==================== FUNCIÓN DE ENVÍO DE CORREO ====================
async function enviarCorreo(email, asunto, html) {
  try {
    const msg = {
      to: email,
      from: FROM_EMAIL,
      subject: asunto,
      html: html,
      text: html.replace(/<[^>]*>/g, '')
    };
    await sgMail.send(msg);
    return true;
  } catch (error) {
    console.error('Error enviando correo con SendGrid:', error.message);
    return false;
  }
}

// ==================== CORREO DE BIENVENIDA ====================
async function enviarCorreoBienvenida(email, nombre) {
  const html = `
    <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 30px; background: #f5f7fa; border-radius: 16px;">
      <div style="text-align: center; margin-bottom: 24px;">
        <h2 style="color: #1F3A5F; font-weight: 700; font-size: 28px; margin: 0;">
          Sel<span style="color: #4A6FA5;">Kalis</span>
        </h2>
      </div>
      <div style="background: #ffffff; padding: 32px; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.06);">
        <h3 style="color: #1F3A5F; font-size: 20px; margin-top: 0; font-weight: 600;">
          ¡Bienvenido a SelKalis, ${nombre}!
        </h3>
        <p style="color: #4F6B8A; font-size: 15px; line-height: 1.6;">
          Nos alegra tenerte con nosotros. Tu cuenta ha sido creada exitosamente y ya puedes empezar a usar todos los servicios de SelKalis.
        </p>
        <div style="background: #EEF3F8; padding: 16px; border-radius: 10px; margin: 20px 0; text-align: center;">
          <p style="color: #1F3A5F; font-size: 14px; margin: 0; font-weight: 500;">
            ¿Listo para comenzar?
          </p>
        </div>
        <p style="color: #7B8CA8; font-size: 13px; margin: 0;">
          Si tienes alguna pregunta, no dudes en contactarnos.
        </p>
      </div>
      <div style="text-align: center; margin-top: 20px; color: #9aabb8; font-size: 12px;">
        &copy; 2025 SelKalis - Todos los derechos reservados
      </div>
    </div>
  `;
  return enviarCorreo(email, '¡Bienvenido a SelKalis!', html);
}

// ==================== CORREO DE RECUPERACIÓN ====================
async function enviarCorreoRecuperacion(email, codigo) {
  const html = `
    <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 30px; background: #f5f7fa; border-radius: 16px;">
      <div style="text-align: center; margin-bottom: 24px;">
        <h2 style="color: #1F3A5F; font-weight: 700; font-size: 28px; margin: 0;">
          Sel<span style="color: #4A6FA5;">Kalis</span>
        </h2>
      </div>
      <div style="background: #ffffff; padding: 32px; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.06);">
        <h3 style="color: #1F3A5F; font-size: 20px; margin-top: 0; font-weight: 600;">
          Recuperación de contraseña
        </h3>
        <p style="color: #4F6B8A; font-size: 15px; line-height: 1.6;">
          Hemos recibido una solicitud para restablecer tu contraseña. Usa el siguiente código de verificación:
        </p>
        <div style="background: #EEF3F8; padding: 18px; border-radius: 10px; text-align: center; margin: 24px 0; font-size: 34px; font-weight: 700; letter-spacing: 6px; color: #1F3A5F; border: 2px dashed #D6E2EE;">
          ${codigo}
        </div>
        <p style="color: #7B8CA8; font-size: 13px; margin: 0;">
          Este código expirará en 15 minutos.
        </p>
        <p style="color: #7B8CA8; font-size: 13px; margin-top: 16px; padding-top: 16px; border-top: 1px solid #EEF3F8;">
          Si no solicitaste este cambio, ignora este mensaje.
        </p>
      </div>
      <div style="text-align: center; margin-top: 20px; color: #9aabb8; font-size: 12px;">
        &copy; 2025 SelKalis - Todos los derechos reservados
      </div>
    </div>
  `;
  return enviarCorreo(email, 'Recuperación de contraseña - SelKalis', html);
}

// ==================== HEALTH CHECK ====================
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    service: 'auth-service',
    timestamp: new Date().toISOString()
  });
});

// ==================== TEST EMAIL ====================
app.get('/test-email', async (req, res) => {
  const email = req.query.email || 'test@example.com';
  const result = await enviarCorreo(
    email,
    'Test de correo SelKalis',
    '<h1>✅ Test exitoso</h1><p>El correo está funcionando correctamente con SendGrid</p>'
  );
  res.json({ 
    success: result, 
    message: result ? 'Correo enviado correctamente' : 'Error al enviar correo',
    email: email
  });
});

// ==================== REGISTRO ====================
app.post('/usuarios/registro', async (req, res) => {
  try {
    const { nombre, apellido, email, telefono, password } = req.body;

    if (!nombre || !apellido || !email || !password) {
      return res.status(400).json({ error: 'Todos los campos son obligatorios' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    }

    const { data: existingUser } = await supabase
      .from('usuarios')
      .select('id')
      .eq('email', email)
      .maybeSingle();

    if (existingUser) {
      return res.status(400).json({ error: 'El email ya está registrado' });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const now = new Date().toISOString();
    
    const { data: newUser, error: insertError } = await supabase
      .from('usuarios')
      .insert({
        nombre,
        apellido,
        email,
        telefono: telefono || null,
        password_hash: passwordHash,
        created_at: now,
        updated_at: now,
        ultimo_login: null,
        activo: true,           // ✅ Por defecto activo
        rol: 'user'             // ✅ Por defecto usuario normal
      })
      .select('id, nombre, apellido, email, telefono, created_at, updated_at, ultimo_login, activo, rol')
      .single();

    if (insertError) {
      console.error('Error al insertar usuario:', insertError);
      return res.status(500).json({
        error: 'Error al crear usuario',
        detalle: insertError.message
      });
    }

    enviarCorreoBienvenida(email, nombre).catch(err => 
      console.error('Error enviando correo de bienvenida:', err)
    );

    const token = jwt.sign(
      {
        id: newUser.id,
        email: newUser.email,
        nombre: newUser.nombre,
        apellido: newUser.apellido,
        rol: newUser.rol
      },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.status(201).json({
      success: true,
      message: 'Usuario registrado exitosamente',
      token: token,
      usuario: {
        id: newUser.id,
        nombre: newUser.nombre,
        apellido: newUser.apellido,
        email: newUser.email,
        telefono: newUser.telefono,
        created_at: newUser.created_at,
        ultimo_login: newUser.ultimo_login,
        activo: newUser.activo,
        rol: newUser.rol
      }
    });

  } catch (error) {
    console.error('Error en registro:', error);
    res.status(500).json({
      error: 'Error interno del servidor',
      mensaje: error.message
    });
  }
});

// ==================== LOGIN (CON VERIFICACIÓN DE ACTIVO) ====================
app.post('/usuarios/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email y contraseña requeridos' });
    }

    const { data: user } = await supabase
      .from('usuarios')
      .select('*')
      .eq('email', email)
      .maybeSingle();

    if (!user) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    // ✅ VERIFICAR SI EL USUARIO ESTÁ ACTIVO
    if (user.activo === false) {
      return res.status(403).json({ 
        error: 'Cuenta desactivada', 
        message: 'Tu cuenta ha sido desactivada. Contacta al administrador.'
      });
    }

    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const now = new Date().toISOString();
    
    await supabase
      .from('usuarios')
      .update({ 
        ultimo_login: now,
        updated_at: now
      })
      .eq('id', user.id);

    const { data: updatedUser } = await supabase
      .from('usuarios')
      .select('id, nombre, apellido, email, telefono, created_at, ultimo_login, activo, rol')
      .eq('id', user.id)
      .single();

    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
        nombre: user.nombre,
        apellido: user.apellido,
        rol: user.rol
      },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    return res.json({
      success: true,
      token,
      user: updatedUser
    });

  } catch (error) {
    console.error('Error en login:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ==================== LOGOUT ====================
app.post('/usuarios/logout', async (req, res) => {
  try {
    res.json({
      success: true,
      message: 'Sesión cerrada exitosamente'
    });
  } catch (error) {
    console.error('Error en logout:', error);
    res.status(500).json({ error: 'Error al cerrar sesión' });
  }
});

// ==================== RECUPERAR CONTRASEÑA ====================
app.post('/auth/recuperar', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'El correo electrónico es requerido' });
    }

    const { data: user } = await supabase
      .from('usuarios')
      .select('id, email, activo')
      .eq('email', email)
      .maybeSingle();

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'No existe una cuenta con este correo electrónico'
      });
    }

    // ✅ No permitir recuperación si está desactivado
    if (user.activo === false) {
      return res.status(403).json({
        success: false,
        error: 'Esta cuenta está desactivada. Contacta al administrador.'
      });
    }

    const codigo = generarCodigo();

    const { error: insertError } = await supabase
      .from('recuperacion_codigos')
      .insert({
        usuario_id: user.id,
        codigo: codigo,
        expiracion: new Date(Date.now() + 15 * 60 * 1000).toISOString()
      });

    if (insertError) {
      console.error('Error guardando código:', insertError);
      return res.status(500).json({
        success: false,
        error: 'Error al generar el código de verificación'
      });
    }

    const emailEnviado = await enviarCorreoRecuperacion(email, codigo);

    if (!emailEnviado) {
      return res.status(500).json({
        success: false,
        error: 'Error al enviar el correo electrónico. Intenta de nuevo.'
      });
    }

    res.json({
      success: true,
      message: 'Código de verificación enviado a tu correo electrónico'
    });

  } catch (error) {
    console.error('Error en recuperar:', error);
    res.status(500).json({ error: 'Error al procesar la solicitud' });
  }
});

// ==================== VERIFICAR CÓDIGO ====================
app.post('/auth/verificar-codigo', async (req, res) => {
  try {
    const { email, codigo } = req.body;

    if (!email || !codigo) {
      return res.status(400).json({ error: 'Email y código son requeridos' });
    }

    if (codigo.length !== 6 || !/^\d{6}$/.test(codigo)) {
      return res.status(400).json({ error: 'El código debe ser de 6 dígitos' });
    }

    const { data: user } = await supabase
      .from('usuarios')
      .select('id, activo')
      .eq('email', email)
      .maybeSingle();

    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    if (user.activo === false) {
      return res.status(403).json({ error: 'Esta cuenta está desactivada' });
    }

    const { data: codigoRecord } = await supabase
      .from('recuperacion_codigos')
      .select('*')
      .eq('usuario_id', user.id)
      .eq('codigo', codigo)
      .eq('usado', false)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (!codigoRecord) {
      return res.status(400).json({ error: 'Código inválido o ya utilizado' });
    }

    const ahora = new Date();
    const expiracion = new Date(codigoRecord.expiracion);

    if (ahora > expiracion) {
      await supabase
        .from('recuperacion_codigos')
        .update({ usado: true })
        .eq('id', codigoRecord.id);

      return res.status(400).json({ error: 'El código ha expirado. Solicita uno nuevo' });
    }

    await supabase
      .from('recuperacion_codigos')
      .update({ usado: true })
      .eq('id', codigoRecord.id);

    const tokenRecuperacion = jwt.sign(
      {
        id: user.id,
        email: email,
        type: 'recuperacion'
      },
      process.env.JWT_SECRET,
      { expiresIn: '15m' }
    );

    res.json({
      success: true,
      message: 'Código verificado correctamente',
      token: tokenRecuperacion
    });

  } catch (error) {
    console.error('Error verificando código:', error);
    res.status(500).json({ error: 'Error al verificar el código' });
  }
});

// ==================== CAMBIAR CONTRASEÑA ====================
app.post('/auth/cambiar-password', async (req, res) => {
  try {
    const { email, token, nuevaPassword } = req.body;

    if (!email || !token || !nuevaPassword) {
      return res.status(400).json({ error: 'Todos los campos son requeridos' });
    }

    if (nuevaPassword.length < 6) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (error) {
      if (error.name === 'TokenExpiredError') {
        return res.status(401).json({ error: 'El enlace ha expirado. Solicita uno nuevo' });
      }
      return res.status(401).json({ error: 'Token inválido' });
    }

    if (decoded.type !== 'recuperacion') {
      return res.status(401).json({ error: 'Token inválido para esta operación' });
    }

    if (decoded.email !== email) {
      return res.status(400).json({ error: 'Email no coincide con el token' });
    }

    const { data: user } = await supabase
      .from('usuarios')
      .select('id, activo')
      .eq('email', email)
      .maybeSingle();

    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    if (user.activo === false) {
      return res.status(403).json({ error: 'Esta cuenta está desactivada' });
    }

    const salt = await bcrypt.genSalt(10);
    const newPasswordHash = await bcrypt.hash(nuevaPassword, salt);

    await supabase
      .from('usuarios')
      .update({
        password_hash: newPasswordHash,
        updated_at: new Date().toISOString()
      })
      .eq('id', user.id);

    await supabase
      .from('recuperacion_codigos')
      .update({ usado: true })
      .eq('usuario_id', user.id);

    res.json({
      success: true,
      message: 'Contraseña actualizada exitosamente'
    });

  } catch (error) {
    console.error('Error cambiando contraseña:', error);
    res.status(500).json({ error: 'Error al cambiar la contraseña' });
  }
});

// ==================== REENVIAR CÓDIGO ====================
app.post('/auth/reenviar-codigo', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'El correo electrónico es requerido' });
    }

    const { data: user } = await supabase
      .from('usuarios')
      .select('id, activo')
      .eq('email', email)
      .maybeSingle();

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'No existe una cuenta con este correo electrónico'
      });
    }

    if (user.activo === false) {
      return res.status(403).json({
        success: false,
        error: 'Esta cuenta está desactivada'
      });
    }

    await supabase
      .from('recuperacion_codigos')
      .update({ usado: true })
      .eq('usuario_id', user.id)
      .eq('usado', false);

    const codigo = generarCodigo();

    await supabase
      .from('recuperacion_codigos')
      .insert({
        usuario_id: user.id,
        codigo: codigo,
        expiracion: new Date(Date.now() + 15 * 60 * 1000).toISOString()
      });

    const emailEnviado = await enviarCorreoRecuperacion(email, codigo);

    if (!emailEnviado) {
      return res.status(500).json({
        success: false,
        error: 'Error al enviar el correo electrónico'
      });
    }

    res.json({
      success: true,
      message: 'Nuevo código enviado a tu correo electrónico'
    });

  } catch (error) {
    console.error('Error reenviando código:', error);
    res.status(500).json({ error: 'Error al reenviar el código' });
  }
});

// ==================== OBTENER USUARIO ====================
app.get('/usuarios/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: user, error } = await supabase
      .from('usuarios')
      .select('id, nombre, apellido, email, telefono, created_at, ultimo_login, activo, rol')
      .eq('id', id)
      .single();

    if (error || !user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    res.json({ success: true, user });

  } catch (error) {
    console.error('Error obteniendo usuario:', error);
    res.status(500).json({ error: 'Error al obtener usuario' });
  }
});

// ==================== ACTUALIZAR USUARIO ====================
app.put('/usuarios/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { nombre, apellido, telefono } = req.body;

    const { data: user, error } = await supabase
      .from('usuarios')
      .update({
        nombre,
        apellido,
        telefono,
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .select('id, nombre, apellido, email, telefono, activo, rol')
      .single();

    if (error) {
      return res.status(500).json({ error: 'Error al actualizar usuario' });
    }

    res.json({ success: true, user });

  } catch (error) {
    console.error('Error actualizando usuario:', error);
    res.status(500).json({ error: 'Error al actualizar usuario' });
  }
});

// ==================== CAMBIAR CONTRASEÑA (logueado) ====================
app.post('/usuarios/cambiar-password', async (req, res) => {
  try {
    const { userId, currentPassword, newPassword } = req.body;

    if (!userId || !currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Todos los campos son requeridos' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 6 caracteres' });
    }

    const { data: user } = await supabase
      .from('usuarios')
      .select('password_hash, activo')
      .eq('id', userId)
      .single();

    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    if (user.activo === false) {
      return res.status(403).json({ error: 'Esta cuenta está desactivada' });
    }

    const isValid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!isValid) {
      return res.status(401).json({ error: 'Contraseña actual incorrecta' });
    }

    const salt = await bcrypt.genSalt(10);
    const newPasswordHash = await bcrypt.hash(newPassword, salt);

    await supabase
      .from('usuarios')
      .update({ 
        password_hash: newPasswordHash,
        updated_at: new Date().toISOString()
      })
      .eq('id', userId);

    res.json({
      success: true,
      message: 'Contraseña actualizada exitosamente'
    });

  } catch (error) {
    console.error('Error cambiando contraseña:', error);
    res.status(500).json({ error: 'Error al cambiar contraseña' });
  }
});

// ============================================================
// ✅ ADMIN ENDPOINTS - Gestión de Usuarios (solo admin)
// ============================================================

// ==================== MIDDLEWARE VERIFICAR ADMIN ====================
const verificarAdmin = async (req, res, next) => {
  try {
    const token = req.headers['authorization']?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ error: 'Token no proporcionado' });
    }
    
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    const { data: user, error } = await supabase
      .from('usuarios')
      .select('rol, activo')
      .eq('id', decoded.id)
      .single();
    
    if (error || !user) {
      return res.status(401).json({ error: 'Usuario no encontrado' });
    }
    
    if (user.activo === false) {
      return res.status(403).json({ error: 'Usuario desactivado' });
    }
    
    if (user.rol !== 'admin') {
      return res.status(403).json({ error: 'Acceso denegado. Se requiere rol de administrador' });
    }
    
    req.usuario_id = decoded.id;
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expirado' });
    }
    return res.status(401).json({ error: 'Token inválido' });
  }
};

// GET /admin/usuarios - Obtener todos los usuarios
app.get('/admin/usuarios', verificarAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('usuarios')
      .select('id, nombre, apellido, email, telefono, rol, activo, created_at, ultimo_login')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error obteniendo usuarios:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /admin/usuarios/:id - Obtener usuario específico
app.get('/admin/usuarios/:id', verificarAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('usuarios')
      .select('id, nombre, apellido, email, telefono, rol, activo, created_at, ultimo_login')
      .eq('id', req.params.id)
      .single();

    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error obteniendo usuario:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /admin/usuarios - Crear usuario (admin)
app.post('/admin/usuarios', verificarAdmin, async (req, res) => {
  try {
    const { nombre, apellido, email, telefono, password, rol } = req.body;

    if (!nombre || !apellido || !email || !password) {
      return res.status(400).json({ error: 'Nombre, apellido, email y contraseña son obligatorios' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    }

    const { data: existingUser } = await supabase
      .from('usuarios')
      .select('id')
      .eq('email', email)
      .maybeSingle();

    if (existingUser) {
      return res.status(400).json({ error: 'El email ya está registrado' });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const now = new Date().toISOString();
    
    const { data: newUser, error } = await supabase
      .from('usuarios')
      .insert({
        nombre,
        apellido,
        email,
        telefono: telefono || null,
        password_hash: passwordHash,
        rol: rol || 'user',
        activo: true,
        created_at: now,
        updated_at: now,
        ultimo_login: null
      })
      .select('id, nombre, apellido, email, telefono, rol, activo, created_at')
      .single();

    if (error) throw error;
    res.status(201).json({ success: true, data: newUser });
  } catch (error) {
    console.error('Error creando usuario:', error);
    res.status(500).json({ error: error.message });
  }
});

// PUT /admin/usuarios/:id - Actualizar usuario (admin)
app.put('/admin/usuarios/:id', verificarAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { nombre, apellido, telefono, rol, activo } = req.body;

    const updateData = {
      updated_at: new Date().toISOString()
    };
    
    if (nombre !== undefined) updateData.nombre = nombre;
    if (apellido !== undefined) updateData.apellido = apellido;
    if (telefono !== undefined) updateData.telefono = telefono || null;
    if (rol !== undefined) updateData.rol = rol;
    if (activo !== undefined) updateData.activo = activo;

    const { data, error } = await supabase
      .from('usuarios')
      .update(updateData)
      .eq('id', id)
      .select('id, nombre, apellido, email, telefono, rol, activo')
      .single();

    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error actualizando usuario:', error);
    res.status(500).json({ error: error.message });
  }
});

// PATCH /admin/usuarios/:id/suspender - Suspender usuario
app.patch('/admin/usuarios/:id/suspender', verificarAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    // No permitir suspender a sí mismo
    if (id === req.usuario_id) {
      return res.status(400).json({ error: 'No puedes suspenderse a ti mismo' });
    }

    const { error } = await supabase
      .from('usuarios')
      .update({ 
        activo: false,
        updated_at: new Date().toISOString()
      })
      .eq('id', id);

    if (error) throw error;
    res.json({ success: true, message: 'Usuario suspendido' });
  } catch (error) {
    console.error('Error suspendiendo usuario:', error);
    res.status(500).json({ error: error.message });
  }
});

// PATCH /admin/usuarios/:id/activar - Activar usuario
app.patch('/admin/usuarios/:id/activar', verificarAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase
      .from('usuarios')
      .update({ 
        activo: true,
        updated_at: new Date().toISOString()
      })
      .eq('id', id);

    if (error) throw error;
    res.json({ success: true, message: 'Usuario activado' });
  } catch (error) {
    console.error('Error activando usuario:', error);
    res.status(500).json({ error: error.message });
  }
});

// DELETE /admin/usuarios/:id - Eliminar usuario (solo admin)
app.delete('/admin/usuarios/:id', verificarAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    // No permitir eliminar a sí mismo
    if (id === req.usuario_id) {
      return res.status(400).json({ error: 'No puedes eliminarte a ti mismo' });
    }

    const { error } = await supabase
      .from('usuarios')
      .delete()
      .eq('id', id);

    if (error) throw error;
    res.json({ success: true, message: 'Usuario eliminado' });
  } catch (error) {
    console.error('Error eliminando usuario:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// LOGS DE ACTIVIDAD (Endpoint adicional)
// ============================================================

// GET /admin/logs - Obtener logs de actividad
app.get('/admin/logs', verificarAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('logs_actividad')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) {
      // Si no existe la tabla, devolver logs simulados
      return res.json({ 
        success: true, 
        data: [
          { id: '1', usuario_id: 'admin', email: 'admin@selkalis.com', accion: 'Login', fecha: new Date().toISOString() },
          { id: '2', usuario_id: 'user1', email: 'user@example.com', accion: 'Registro', fecha: new Date().toISOString() }
        ] 
      });
    }
    
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error obteniendo logs:', error);
    res.json({ success: true, data: [] });
  }
});

// ==================== INICIAR SERVIDOR ====================
app.listen(PORT, () => {
  console.log(`   Auth service running on port ${PORT}`);
  console.log(`   Email configurado: ${FROM_EMAIL}`);
  console.log(`   CORS permitido para: ${frontendUrl}`);
  console.log(`   Health check: http://localhost:${PORT}/health`);
  console.log(`   Admin endpoints disponibles:`);
  console.log(`   GET    /admin/usuarios`);
  console.log(`   GET    /admin/usuarios/:id`);
  console.log(`   POST   /admin/usuarios`);
  console.log(`   PUT    /admin/usuarios/:id`);
  console.log(`   PATCH  /admin/usuarios/:id/suspender`);
  console.log(`   PATCH  /admin/usuarios/:id/activar`);
  console.log(`   DELETE /admin/usuarios/:id`);
});

module.exports = app;
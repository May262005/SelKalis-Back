const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');
const sgMail = require('@sendgrid/mail');
const path = require('path');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse
} = require('@simplewebauthn/server');

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
  console.error('Ve a https://signup.sendgrid.com y crea una API Key');
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

// ==================== MIDDLEWARES DE AUTENTICACIÓN ====================

// Verifica JWT válido (cualquier rol)

const verificarToken = (req, res, next) => {
  try {
    const token = req.headers['authorization']?.split(' ')[1];

    if (!token) {
      return res.status(401).json({ error: 'Token no proporcionado' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    req.usuario_id = decoded.id;
    req.usuario_email = decoded.email;
    req.usuario_rol = decoded.rol;

    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expirado' });
    }

    return res.status(401).json({ error: 'Token inválido' });
  }
};

// Verifica JWT + rol admin

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
      return res.status(403).json({
        error: 'Acceso denegado. Se requiere rol de administrador'
      });
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
    etapa2: 'dispositivo + biometria + telefono',
    timestamp: new Date().toISOString()
  });
});

// ==================== TEST EMAIL ====================

app.get('/test-email', async (req, res) => {
  const email = req.query.email || 'test@example.com';

  const result = await enviarCorreo(
    email,
    'Test de correo SelKalis',
    '<h1>Test exitoso</h1><p>El correo está funcionando correctamente con SendGrid</p>'
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
      return res.status(400).json({
        error: 'La contraseña debe tener al menos 6 caracteres'
      });
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
        activo: true,
        rol: 'user'
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
      return res.status(400).json({
        error: 'El correo electrónico es requerido'
      });
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

      return res.status(400).json({
        error: 'El código ha expirado. Solicita uno nuevo'
      });
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

// ==================== CAMBIAR CONTRASEÑA (con token de recuperación) ====================

app.post('/auth/cambiar-password', async (req, res) => {
  try {
    const { email, token, nuevaPassword } = req.body;

    if (!email || !token || !nuevaPassword) {
      return res.status(400).json({ error: 'Todos los campos son requeridos' });
    }

    if (nuevaPassword.length < 6) {
      return res.status(400).json({
        error: 'La contraseña debe tener al menos 6 caracteres'
      });
    }

    let decoded;

    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (error) {
      if (error.name === 'TokenExpiredError') {
        return res.status(401).json({
          error: 'El enlace ha expirado. Solicita uno nuevo'
        });
      }

      return res.status(401).json({ error: 'Token inválido' });
    }

    if (decoded.type !== 'recuperacion') {
      return res.status(401).json({
        error: 'Token inválido para esta operación'
      });
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
      return res.status(400).json({
        error: 'El correo electrónico es requerido'
      });
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
      return res.status(400).json({
        error: 'La nueva contraseña debe tener al menos 6 caracteres'
      });
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
// ETAPA 2 — VINCULACIÓN DE TELÉFONO, DISPOSITIVO Y BIOMETRÍA
// ============================================================

// ==================== VINCULAR / ACTUALIZAR TELÉFONO ====================
// POST /usuarios/:id/telefono

app.post('/usuarios/:id/telefono', verificarToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { telefono } = req.body;

    if (req.usuario_id !== id) {
      return res.status(403).json({
        error: 'No puedes modificar otra cuenta'
      });
    }

    if (!telefono || !/^\+?[0-9]{10,15}$/.test(telefono)) {
      return res.status(400).json({
        error: 'Número de teléfono inválido (10-15 dígitos, opcional +)'
      });
    }

    const now = new Date().toISOString();

    const { data: user, error } = await supabase
      .from('usuarios')
      .update({ telefono, updated_at: now })
      .eq('id', id)
      .select('id, telefono, updated_at')
      .single();

    if (error) throw error;

    res.json({
      success: true,
      message: 'Teléfono vinculado exitosamente',
      telefono: user.telefono
    });
  } catch (error) {
    console.error('Error vinculando teléfono:', error);

    res.status(500).json({
      error: 'Error al vincular teléfono',
      detalle: error.message
    });
  }
});

// ==================== ASOCIAR DISPOSITIVO ====================
// POST /usuarios/:id/dispositivo

app.post('/usuarios/:id/dispositivo', verificarToken, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      device_id,
      device_platform,
      device_model,
      device_token
    } = req.body;

    if (req.usuario_id !== id) {
      return res.status(403).json({
        error: 'No puedes asociar un dispositivo a otra cuenta'
      });
    }

    if (!device_id || !device_platform) {
      return res.status(400).json({
        error: 'device_id y device_platform son obligatorios'
      });
    }

    if (!['android', 'ios', 'web'].includes(device_platform)) {
      return res.status(400).json({
        error: 'device_platform inválido (android | ios | web)'
      });
    }

    const now = new Date().toISOString();

    const { data: user, error } = await supabase
      .from('usuarios')
      .update({
        device_id,
        device_platform,
        device_model: device_model || null,
        device_token: device_token || null,
        device_linked_at: now,
        updated_at: now
      })
      .eq('id', id)
      .select('id, nombre, email, telefono, device_id, device_platform, device_model, device_linked_at')
      .single();

    if (error) throw error;

    await supabase
      .from('dispositivos_usuario')
      .update({
        activo: false,
        updated_at: now
      })
      .eq('usuario_id', id)
      .eq('activo', true);

    const { data: existing } = await supabase
      .from('dispositivos_usuario')
      .select('id')
      .eq('usuario_id', id)
      .eq('device_id', device_id)
      .maybeSingle();

    if (existing) {
      await supabase
        .from('dispositivos_usuario')
        .update({
          activo: true,
          device_platform,
          device_model: device_model || null,
          updated_at: now
        })
        .eq('id', existing.id);
    } else {
      await supabase
        .from('dispositivos_usuario')
        .insert({
          usuario_id: id,
          device_id,
          device_platform,
          device_model: device_model || null,
          activo: true
        });
    }

    res.json({
      success: true,
      message: 'Dispositivo asociado exitosamente',
      dispositivo: {
        device_id: user.device_id,
        device_platform: user.device_platform,
        device_model: user.device_model,
        device_linked_at: user.device_linked_at
      }
    });
  } catch (error) {
    console.error('Error asociando dispositivo:', error);

    res.status(500).json({
      error: 'Error al asociar dispositivo',
      detalle: error.message
    });
  }
});

// ==================== OBTENER ESTADO DE VINCULACIÓN ====================
// GET /usuarios/:id/dispositivo

app.get('/usuarios/:id/dispositivo', verificarToken, async (req, res) => {
  try {
    const { id } = req.params;

    if (req.usuario_id !== id) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }

    const { data: user, error } = await supabase
      .from('usuarios')
      .select('telefono, device_id, device_platform, device_model, device_linked_at, biometric_enabled, biometric_enabled_at')
      .eq('id', id)
      .single();

    if (error || !user) {
      return res.status(404).json({
        error: 'Usuario no encontrado'
      });
    }

    res.json({
      success: true,
      vinculacion: {
        telefono_vinculado: !!user.telefono,
        telefono: user.telefono,
        dispositivo_asociado: !!user.device_id,
        device_id: user.device_id,
        device_platform: user.device_platform,
        device_model: user.device_model,
        device_linked_at: user.device_linked_at,
        biometria_habilitada: user.biometric_enabled || false,
        biometria_habilitada_at: user.biometric_enabled_at
      }
    });
  } catch (error) {
    console.error('Error obteniendo dispositivo:', error);

    res.status(500).json({
      error: 'Error al obtener estado del dispositivo'
    });
  }
});

// ==================== DESASOCIAR DISPOSITIVO ====================
// DELETE /usuarios/:id/dispositivo

app.delete('/usuarios/:id/dispositivo', verificarToken, async (req, res) => {
  try {
    const { id } = req.params;

    if (req.usuario_id !== id) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }

    const now = new Date().toISOString();

    await supabase
      .from('usuarios')
      .update({
        device_id: null,
        device_token: null,
        device_platform: null,
        device_model: null,
        device_linked_at: null,
        updated_at: now
      })
      .eq('id', id);

    await supabase
      .from('dispositivos_usuario')
      .update({
        activo: false,
        updated_at: now
      })
      .eq('usuario_id', id)
      .eq('activo', true);

    res.json({
      success: true,
      message: 'Dispositivo desasociado'
    });
  } catch (error) {
    console.error('Error desasociando dispositivo:', error);

    res.status(500).json({
      error: 'Error al desasociar dispositivo'
    });
  }
});

// ==================== HABILITAR / DESHABILITAR BIOMETRÍA ====================
// PATCH /usuarios/:id/biometria

app.patch('/usuarios/:id/biometria', verificarToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { enabled } = req.body;

    if (req.usuario_id !== id) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }

    if (typeof enabled !== 'boolean') {
      return res.status(400).json({
        error: 'enabled debe ser true o false'
      });
    }

    const now = new Date().toISOString();

    const { data: user, error } = await supabase
      .from('usuarios')
      .update({
        biometric_enabled: enabled,
        biometric_enabled_at: enabled ? now : null,
        updated_at: now
      })
      .eq('id', id)
      .select('biometric_enabled, biometric_enabled_at')
      .single();

    if (error) throw error;

    res.json({
      success: true,
      message: enabled ? 'Biometría habilitada' : 'Biometría deshabilitada',
      biometria: user
    });
  } catch (error) {
    console.error('Error actualizando biometría:', error);

    res.status(500).json({
      error: 'Error al actualizar biometría'
    });
  }
});

// ============================================================
// ADMIN ENDPOINTS — GESTIÓN DE USUARIOS
// ============================================================

// GET /admin/usuarios

app.get('/admin/usuarios', verificarAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('usuarios')
      .select('id, nombre, apellido, email, telefono, rol, activo, created_at, ultimo_login, device_id, device_platform, biometric_enabled')
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({ success: true, data });
  } catch (error) {
    console.error('Error obteniendo usuarios:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /admin/usuarios/:id

app.get('/admin/usuarios/:id', verificarAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('usuarios')
      .select('id, nombre, apellido, email, telefono, rol, activo, created_at, ultimo_login, device_id, device_platform, device_model, device_linked_at, biometric_enabled, biometric_enabled_at')
      .eq('id', req.params.id)
      .single();

    if (error) throw error;

    res.json({ success: true, data });
  } catch (error) {
    console.error('Error obteniendo usuario:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /admin/usuarios

app.post('/admin/usuarios', verificarAdmin, async (req, res) => {
  try {
    const { nombre, apellido, email, telefono, password, rol } = req.body;

    if (!nombre || !apellido || !email || !password) {
      return res.status(400).json({
        error: 'Nombre, apellido, email y contraseña son obligatorios'
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        error: 'La contraseña debe tener al menos 6 caracteres'
      });
    }

    const { data: existingUser } = await supabase
      .from('usuarios')
      .select('id')
      .eq('email', email)
      .maybeSingle();

    if (existingUser) {
      return res.status(400).json({
        error: 'El email ya está registrado'
      });
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

    res.status(201).json({
      success: true,
      data: newUser
    });
  } catch (error) {
    console.error('Error creando usuario:', error);
    res.status(500).json({ error: error.message });
  }
});

// PUT /admin/usuarios/:id

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

// PATCH /admin/usuarios/:id/suspender

app.patch('/admin/usuarios/:id/suspender', verificarAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    if (id === req.usuario_id) {
      return res.status(400).json({
        error: 'No puedes suspenderte a ti mismo'
      });
    }

    const { error } = await supabase
      .from('usuarios')
      .update({
        activo: false,
        updated_at: new Date().toISOString()
      })
      .eq('id', id);

    if (error) throw error;

    res.json({
      success: true,
      message: 'Usuario suspendido'
    });
  } catch (error) {
    console.error('Error suspendiendo usuario:', error);
    res.status(500).json({ error: error.message });
  }
});

// PATCH /admin/usuarios/:id/activar

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

    res.json({
      success: true,
      message: 'Usuario activado'
    });
  } catch (error) {
    console.error('Error activando usuario:', error);
    res.status(500).json({ error: error.message });
  }
});

// DELETE /admin/usuarios/:id

app.delete('/admin/usuarios/:id', verificarAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    if (id === req.usuario_id) {
      return res.status(400).json({
        error: 'No puedes eliminarte a ti mismo'
      });
    }

    const { error } = await supabase
      .from('usuarios')
      .delete()
      .eq('id', id);

    if (error) throw error;

    res.json({
      success: true,
      message: 'Usuario eliminado'
    });
  } catch (error) {
    console.error('Error eliminando usuario:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// LOGS DE ACTIVIDAD
// ============================================================

// GET /admin/logs

app.get('/admin/logs', verificarAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('logs_actividad')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) {
      return res.json({
        success: true,
        data: [
          {
            id: '1',
            usuario_id: 'admin',
            email: 'admin@selkalis.com',
            accion: 'Login',
            fecha: new Date().toISOString()
          },
          {
            id: '2',
            usuario_id: 'user1',
            email: 'user@example.com',
            accion: 'Registro',
            fecha: new Date().toISOString()
          }
        ]
      });
    }

    res.json({ success: true, data });
  } catch (error) {
    console.error('Error obteniendo logs:', error);
    res.json({ success: true, data: [] });
  }
});

// ============================================================
// ETAPA 3 — WEBAUTHN (biometría en navegador / PWA)
// ============================================================

const RP_NAME = 'SelKalis';
const RP_ID = process.env.WEBAUTHN_RP_ID || 'selkalis.vercel.app';
const ORIGIN = process.env.WEBAUTHN_ORIGIN || 'https://selkalis.vercel.app';
const CHALLENGE_TTL_MIN = 5;

// ==================== GUARDAR CHALLENGE ====================

async function guardarChallenge(usuarioId, challenge, tipo) {
  const expiracion = new Date(
    Date.now() + CHALLENGE_TTL_MIN * 60 * 1000
  ).toISOString();

  const { error } = await supabase
    .from('webauthn_challenges')
    .insert({
      usuario_id: usuarioId,
      challenge,
      tipo,
      expiracion,
      usado: false
    });

  if (error) throw error;
}

// ==================== CONSUMIR CHALLENGE ====================

async function consumirChallenge(challenge, tipo, usuarioId) {
  if (!challenge) return null;

  let query = supabase
    .from('webauthn_challenges')
    .select('*')
    .eq('challenge', challenge)
    .eq('tipo', tipo)
    .eq('usado', false);

  if (usuarioId) {
    query = query.eq('usuario_id', usuarioId);
  }

  const { data, error } = await query
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  if (new Date() > new Date(data.expiracion)) {
    await supabase
      .from('webauthn_challenges')
      .update({ usado: true })
      .eq('id', data.id);

    return null;
  }

  const { error: updateError } = await supabase
    .from('webauthn_challenges')
    .update({ usado: true })
    .eq('id', data.id)
    .eq('usado', false);

  if (updateError) throw updateError;

  return data;
}

// ==================== OBTENER CHALLENGE ====================

function obtenerChallengeDeCredential(credential) {
  const clientDataJSON = credential?.response?.clientDataJSON;

  if (!clientDataJSON) return null;

  try {
    const clientData = JSON.parse(
      Buffer.from(clientDataJSON, 'base64url').toString('utf8')
    );

    return clientData.challenge || null;
  } catch {
    return null;
  }
}

// ==================== REGISTRO: GENERAR OPCIONES ====================
// POST /webauthn/registro/opciones

app.post('/webauthn/registro/opciones', verificarToken, async (req, res) => {
  try {
    const id = req.usuario_id;

    const { data: user, error: userError } = await supabase
      .from('usuarios')
      .select('id, email, nombre, apellido, activo')
      .eq('id', id)
      .maybeSingle();

    if (userError) throw userError;

    if (!user) {
      return res.status(404).json({
        error: 'Usuario no encontrado'
      });
    }

    if (user.activo === false) {
      return res.status(403).json({
        error: 'Cuenta desactivada'
      });
    }

    const { data: existentes, error: credentialsError } = await supabase
      .from('webauthn_credentials')
      .select('credential_id, transports')
      .eq('usuario_id', id);

    if (credentialsError) throw credentialsError;

    const excludeCredentials = (existentes || []).map((item) => ({
      id: item.credential_id,
      type: 'public-key',
      transports: item.transports || []
    }));

    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: RP_ID,
      userID: new Uint8Array(Buffer.from(String(user.id), 'utf8')),
      userName: user.email,
      userDisplayName:
        `${user.nombre || ''} ${user.apellido || ''}`.trim() || user.email,
      attestationType: 'none',
      excludeCredentials,
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'required',
        authenticatorAttachment: 'platform'
      }
    });

    await guardarChallenge(id, options.challenge, 'registro');

    return res.json({
      success: true,
      options
    });
  } catch (error) {
    console.error('Error webauthn registro/opciones:', error);

    return res.status(500).json({
      error: 'No se pudieron generar las opciones de registro'
    });
  }
});

// ==================== REGISTRO: VERIFICAR CREDENCIAL ====================
// POST /webauthn/registro/verificar

app.post('/webauthn/registro/verificar', verificarToken, async (req, res) => {
  try {
    const id = req.usuario_id;
    const { credential, device_label } = req.body;

    if (!credential || !credential.response) {
      return res.status(400).json({
        error: 'Credencial incompleta'
      });
    }

    const { data: user, error: userError } = await supabase
      .from('usuarios')
      .select('id, activo')
      .eq('id', id)
      .maybeSingle();

    if (userError) throw userError;

    if (!user) {
      return res.status(404).json({
        error: 'Usuario no encontrado'
      });
    }

    if (user.activo === false) {
      return res.status(403).json({
        error: 'Cuenta desactivada'
      });
    }

    const challenge = obtenerChallengeDeCredential(credential);

    const challengeRecord = await consumirChallenge(
      challenge,
      'registro',
      id
    );

    if (!challengeRecord) {
      return res.status(400).json({
        error: 'Challenge inválido, usado o expirado'
      });
    }

    const verification = await verifyRegistrationResponse({
      response: credential,
      expectedChallenge: challengeRecord.challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID
    });

    if (!verification.verified || !verification.registrationInfo) {
      return res.status(400).json({
        error: 'Verificación de registro fallida'
      });
    }

    const { credential: registeredCredential } =
      verification.registrationInfo;

    const { error: insertError } = await supabase
      .from('webauthn_credentials')
      .insert({
        usuario_id: id,
        credential_id: registeredCredential.id,
        public_key: Buffer.from(
          registeredCredential.publicKey
        ).toString('base64url'),
        counter: registeredCredential.counter,
        transports: registeredCredential.transports || [],
        device_label: device_label || 'Dispositivo',
        created_at: new Date().toISOString()
      });

    if (insertError) throw insertError;

    const { error: updateError } = await supabase
      .from('usuarios')
      .update({
        biometric_enabled: true,
        biometric_enabled_at: new Date().toISOString()
      })
      .eq('id', id);

    if (updateError) throw updateError;

    return res.json({
      success: true,
      message: 'Biometría registrada correctamente'
    });
  } catch (error) {
    console.error('Error webauthn registro/verificar:', error);

    return res.status(400).json({
      error: 'No se pudo verificar el registro biométrico',
      detalle: error.message
    });
  }
});

// ==================== LOGIN: GENERAR OPCIONES ====================
// POST /webauthn/login/opciones

app.post('/webauthn/login/opciones', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        error: 'Email requerido'
      });
    }

    const { data: user, error: userError } = await supabase
      .from('usuarios')
      .select('id, email, biometric_enabled, activo')
      .eq('email', email)
      .maybeSingle();

    if (userError) throw userError;

    if (!user || user.activo === false) {
      return res.status(400).json({
        error: 'No se pudo iniciar el acceso biométrico'
      });
    }

    if (!user.biometric_enabled) {
      return res.status(400).json({
        error: 'La biometría no está habilitada para esta cuenta'
      });
    }

    const { data: credentials, error: credentialsError } = await supabase
      .from('webauthn_credentials')
      .select('credential_id, transports')
      .eq('usuario_id', user.id);

    if (credentialsError) throw credentialsError;

    if (!credentials || credentials.length === 0) {
      return res.status(400).json({
        error: 'No hay credenciales registradas'
      });
    }

    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      allowCredentials: credentials.map((item) => ({
        id: item.credential_id,
        type: 'public-key',
        transports: item.transports || []
      })),
      userVerification: 'required'
    });

    await guardarChallenge(user.id, options.challenge, 'login');

    return res.json({
      success: true,
      options,
      userId: user.id
    });
  } catch (error) {
    console.error('Error webauthn login/opciones:', error);

    return res.status(500).json({
      error: 'No se pudieron generar las opciones de autenticación'
    });
  }
});

// ==================== LOGIN: VERIFICAR CREDENCIAL ====================
// POST /webauthn/login/verificar

app.post('/webauthn/login/verificar', async (req, res) => {
  try {
    const { email, credential } = req.body;

    if (!email || !credential || !credential.response) {
      return res.status(400).json({
        error: 'Datos incompletos'
      });
    }

    const { data: user, error: userError } = await supabase
      .from('usuarios')
      .select('id, email, nombre, apellido, telefono, rol, activo, biometric_enabled')
      .eq('email', email)
      .maybeSingle();

    if (userError) throw userError;

    if (!user || user.activo === false || !user.biometric_enabled) {
      return res.status(401).json({
        error: 'No se pudo autenticar la cuenta'
      });
    }

    const { data: storedCredential, error: storedCredentialError } =
      await supabase
        .from('webauthn_credentials')
        .select('*')
        .eq('usuario_id', user.id)
        .eq('credential_id', credential.id)
        .maybeSingle();

    if (storedCredentialError) throw storedCredentialError;

    if (!storedCredential) {
      return res.status(401).json({
        error: 'Credencial no reconocida'
      });
    }

    const challenge = obtenerChallengeDeCredential(credential);

    const challengeRecord = await consumirChallenge(
      challenge,
      'login',
      user.id
    );

    if (!challengeRecord) {
      return res.status(400).json({
        error: 'Challenge inválido, usado o expirado'
      });
    }

    const verification = await verifyAuthenticationResponse({
      response: credential,
      expectedChallenge: challengeRecord.challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      credential: {
        id: storedCredential.credential_id,
        publicKey: new Uint8Array(
          Buffer.from(storedCredential.public_key, 'base64url')
        ),
        counter: Number(storedCredential.counter),
        transports: storedCredential.transports || []
      }
    });

    if (!verification.verified) {
      return res.status(401).json({
        error: 'Verificación biométrica fallida'
      });
    }

    const { error: updateCredentialError } = await supabase
      .from('webauthn_credentials')
      .update({
        counter: verification.authenticationInfo.newCounter,
        last_used_at: new Date().toISOString()
      })
      .eq('id', storedCredential.id);

    if (updateCredentialError) throw updateCredentialError;

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
      user: {
        id: user.id,
        nombre: user.nombre,
        apellido: user.apellido,
        email: user.email,
        telefono: user.telefono,
        rol: user.rol
      }
    });
  } catch (error) {
    console.error('Error webauthn login/verificar:', error);

    return res.status(400).json({
      error: 'No se pudo completar la autenticación biométrica',
      detalle: error.message
    });
  }
});

// ==================== CONSULTAR ESTADO BIOMÉTRICO ====================
// GET /webauthn/estado/:email

app.get('/webauthn/estado/:email', async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email);

    const { data: user, error } = await supabase
      .from('usuarios')
      .select('id, biometric_enabled')
      .eq('email', email)
      .maybeSingle();

    if (error) throw error;

    if (!user) {
      return res.json({
        success: true,
        biometric_enabled: false,
        tiene_credenciales: false
      });
    }

    const { count, error: countError } = await supabase
      .from('webauthn_credentials')
      .select('id', { count: 'exact', head: true })
      .eq('usuario_id', user.id);

    if (countError) throw countError;

    return res.json({
      success: true,
      biometric_enabled: Boolean(user.biometric_enabled),
      tiene_credenciales: (count || 0) > 0
    });
  } catch (error) {
    console.error('Error webauthn estado:', error);

    return res.status(500).json({
      error: 'No se pudo consultar el estado biométrico'
    });
  }
});

// ==================== INICIAR SERVIDOR ====================

app.listen(PORT, () => {
  console.log(`Auth service running on port ${PORT}`);
  console.log(`Email configurado: ${FROM_EMAIL}`);
  console.log(`CORS permitido para: ${frontendUrl}`);
  console.log(`Health check: http://localhost:${PORT}/health`);

  console.log('--- ETAPA 1: Auth base ---');
  console.log('POST   /usuarios/registro');
  console.log('POST   /usuarios/login');
  console.log('POST   /usuarios/logout');
  console.log('POST   /auth/recuperar');
  console.log('POST   /auth/verificar-codigo');
  console.log('POST   /auth/cambiar-password');
  console.log('POST   /auth/reenviar-codigo');
  console.log('GET    /usuarios/:id');
  console.log('PUT    /usuarios/:id');
  console.log('POST   /usuarios/cambiar-password');

  console.log('--- ETAPA 2: Dispositivo / Teléfono / Biometría ---');
  console.log('POST   /usuarios/:id/telefono');
  console.log('POST   /usuarios/:id/dispositivo');
  console.log('GET    /usuarios/:id/dispositivo');
  console.log('DELETE /usuarios/:id/dispositivo');
  console.log('PATCH  /usuarios/:id/biometria');

  console.log('--- WEBAUTHN (biometría web) ---');
  console.log('POST   /webauthn/registro/opciones');
  console.log('POST   /webauthn/registro/verificar');
  console.log('POST   /webauthn/login/opciones');
  console.log('POST   /webauthn/login/verificar');
  console.log('GET    /webauthn/estado/:email');

  console.log('--- ADMIN ---');
  console.log('GET    /admin/usuarios');
  console.log('GET    /admin/usuarios/:id');
  console.log('POST   /admin/usuarios');
  console.log('PUT    /admin/usuarios/:id');
  console.log('PATCH  /admin/usuarios/:id/suspender');
  console.log('PATCH  /admin/usuarios/:id/activar');
  console.log('DELETE /admin/usuarios/:id');
  console.log('GET    /admin/logs');
});

module.exports = app;
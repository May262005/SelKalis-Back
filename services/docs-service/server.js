const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const jwt = require('jsonwebtoken');
const supabase = require('./db');

require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const app = express();
const PORT = process.env.DOCUMENTOS_PORT || 3005;

// ==================== VALIDACION ====================
if (!process.env.JWT_SECRET) {
  console.error('ERROR: JWT_SECRET no esta definido');
  process.exit(1);
}

// ==================== CORS ====================
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

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  next();
});

// ==================== LIMITES ====================
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// ==================== MULTER ====================
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 50 * 1024 * 1024,
    fieldSize: 50 * 1024 * 1024
  }
});

// ==================== BUCKET ====================
const BUCKET_NAME = 'documentos';

async function crearBucketSiNoExiste() {
  try {
    console.log(`Verificando bucket "${BUCKET_NAME}"...`);

    const { data: buckets, error } = await supabase.storage.listBuckets();

    if (error) {
      console.error('Error al listar buckets:', error);
      return;
    }

    const bucketExiste = buckets?.some(b => b.name === BUCKET_NAME);

    if (!bucketExiste) {
      console.log(`Creando bucket "${BUCKET_NAME}"...`);
      const { error: createError } = await supabase.storage.createBucket(
        BUCKET_NAME,
        {
          public: true,
          fileSizeLimit: 50 * 1024 * 1024,
          allowedMimeTypes: [
            'image/*',
            'application/pdf',
            'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/vnd.ms-excel',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'text/plain'
          ]
        }
      );

      if (createError) {
        console.error('Error al crear bucket:', createError);
      } else {
        console.log(`Bucket "${BUCKET_NAME}" creado correctamente`);
      }
    } else {
      console.log(`Bucket "${BUCKET_NAME}" ya existe`);
    }
  } catch (error) {
    console.error('Error en crearBucketSiNoExiste:', error);
  }
}

crearBucketSiNoExiste();

// ==================== HELPERS ====================
function formatearTamano(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// ==================== EXTRAER USUARIO ====================
function extraerUsuarioId(req) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      console.log('No hay header Authorization');
      return null;
    }

    const token = authHeader.split(' ')[1];
    if (!token) {
      console.log('No hay token en el header');
      return null;
    }

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      console.log('Token valido para usuario:', decoded.id);
      return decoded.id;
    } catch (verifyError) {
      console.log('Token invalido:', verifyError.message);
      return null;
    }
  } catch (error) {
    console.error('Error extrayendo usuario:', error);
    return null;
  }
}

// ==================== ENDPOINTS ====================

// HEALTH
app.get('/health', (req, res) => {
  res.json({ status: 'OK', service: 'documentos-service' });
});

// GET documentos
app.get('/documentos', async (req, res) => {
  try {
    const usuarioId = extraerUsuarioId(req);

    if (!usuarioId) {
      return res.status(401).json({
        success: false,
        error: 'Debes iniciar sesion para ver tus documentos.'
      });
    }

    const { categoria } = req.query;

    let query = supabase
      .from('documentos')
      .select('*')
      .eq('usuario_id', usuarioId)
      .order('created_at', { ascending: false });

    if (categoria && categoria !== 'todos') {
      query = query.eq('categoria', categoria);
    }

    const { data, error } = await query;

    if (error) {
      console.error('Error al obtener documentos:', error);
      return res.status(500).json({
        success: false,
        error: 'No pudimos cargar tus documentos. Intenta de nuevo.'
      });
    }

    res.json({
      success: true,
      data: data.map(doc => ({
        ...doc,
        tamano: formatearTamano(doc.tamano)
      }))
    });

  } catch (error) {
    console.error('Error en GET /documentos:', error);
    res.status(500).json({
      success: false,
      error: 'Ocurrio un error al cargar tus documentos.'
    });
  }
});

// POST upload
app.post('/documentos/upload', (req, res, next) => {
  console.log('=== NUEVA SOLICITUD DE UPLOAD ===');
  console.log('Content-Type:', req.headers['content-type']);
  console.log('Authorization:', req.headers.authorization ? 'Presente' : 'Ausente');

  const contentType = req.headers['content-type'] || '';
  if (!contentType.includes('multipart/form-data')) {
    return res.status(400).json({
      success: false,
      error: 'El formato de la solicitud no es correcto. Asegurate de usar FormData.'
    });
  }

  next();
}, upload.single('file'), async (req, res, next) => {
  try {
    console.log('Archivo recibido por Multer');

    const file = req.file;
    const { nombre, categoria, descripcion } = req.body;
    const usuarioId = extraerUsuarioId(req);

    console.log('Datos recibidos:');
    console.log('  Usuario:', usuarioId);
    console.log('  Nombre:', nombre);
    console.log('  Categoria:', categoria);
    console.log('  Archivo:', file ? file.originalname : 'NO HAY ARCHIVO');
    console.log('  Tamano:', file ? file.size : 'N/A');
    console.log('  Tipo:', file ? file.mimetype : 'N/A');

    // Validaciones
    if (!usuarioId) {
      return res.status(401).json({
        success: false,
        error: 'Debes iniciar sesion para subir documentos.'
      });
    }

    if (!file) {
      return res.status(400).json({
        success: false,
        error: 'No seleccionaste ningun archivo. Elige un archivo para subir.'
      });
    }

    if (!nombre || nombre.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'Escribe un nombre para el documento.'
      });
    }

    // Validar tamano
    if (file.size > 50 * 1024 * 1024) {
      return res.status(413).json({
        success: false,
        error: `El archivo pesa ${formatearTamano(file.size)}. El limite maximo es 50 MB.`
      });
    }

    // Validar tipo
    const tiposPermitidos = [
      'image/jpeg', 'image/png', 'image/gif', 'image/webp',
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/plain'
    ];

    if (!tiposPermitidos.includes(file.mimetype)) {
      return res.status(400).json({
        success: false,
        error: `El tipo de archivo "${file.mimetype}" no esta permitido. Sube imagenes, PDF, Word, Excel o texto.`
      });
    }

    const fileName = `${Date.now()}_${file.originalname}`;

    // Subir a Supabase
    console.log('Subiendo a Supabase...');
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from(BUCKET_NAME)
      .upload(fileName, file.buffer, {
        contentType: file.mimetype,
        cacheControl: '3600',
        upsert: false,
      });

    if (uploadError) {
      console.error('Error al subir a Supabase:', uploadError);
      return res.status(500).json({
        success: false,
        error: 'No pudimos subir tu archivo. Intenta de nuevo.'
      });
    }
    console.log('Archivo subido a Supabase');

    // Obtener URL
    const { data: urlData } = supabase.storage
      .from(BUCKET_NAME)
      .getPublicUrl(fileName);
    const publicUrl = urlData.publicUrl;

    // Guardar metadata
    console.log('Guardando metadata...');
    const { data: documento, error: dbError } = await supabase
      .from('documentos')
      .insert({
        nombre: nombre.trim(),
        tipo: file.mimetype,
        tamano: file.size,
        categoria: categoria || 'otro',
        descripcion: descripcion || '',
        url: publicUrl,
        usuario_id: usuarioId,
        created_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (dbError) {
      console.error('Error al guardar metadata:', dbError);
      await supabase.storage.from(BUCKET_NAME).remove([fileName]);
      return res.status(500).json({
        success: false,
        error: 'El archivo se subio pero no pudimos guardar la informacion.'
      });
    }
    console.log('Documento guardado en base de datos');

    res.json({
      success: true,
      message: 'Documento subido con exito.',
      data: {
        ...documento,
        tamano: formatearTamano(documento.tamano)
      }
    });

  } catch (error) {
    // Se delega al manejador de errores general al final del archivo
    next(error);
  }
});

// GET documento
app.get('/documentos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const usuarioId = extraerUsuarioId(req);

    if (!usuarioId) {
      return res.status(401).json({
        success: false,
        error: 'Debes iniciar sesion para ver este documento.'
      });
    }

    const { data, error } = await supabase
      .from('documentos')
      .select('*')
      .eq('id', id)
      .eq('usuario_id', usuarioId)
      .single();

    if (error || !data) {
      return res.status(404).json({
        success: false,
        error: 'No encontramos el documento que buscas.'
      });
    }

    res.json({
      success: true,
      data: {
        ...data,
        tamano: formatearTamano(data.tamano)
      }
    });

  } catch (error) {
    console.error('Error en GET /documentos/:id:', error);
    res.status(500).json({
      success: false,
      error: 'Error al cargar el documento.'
    });
  }
});

// GET descargar
app.get('/documentos/:id/descargar', async (req, res) => {
  try {
    const { id } = req.params;
    const usuarioId = extraerUsuarioId(req);

    if (!usuarioId) {
      return res.status(401).json({
        success: false,
        error: 'Debes iniciar sesion para descargar este documento.'
      });
    }

    const { data, error } = await supabase
      .from('documentos')
      .select('url, nombre')
      .eq('id', id)
      .eq('usuario_id', usuarioId)
      .single();

    if (error || !data) {
      return res.status(404).json({
        success: false,
        error: 'No encontramos el documento para descargar.'
      });
    }

    res.redirect(data.url);

  } catch (error) {
    console.error('Error en GET /documentos/:id/descargar:', error);
    res.status(500).json({
      success: false,
      error: 'Error al descargar el documento.'
    });
  }
});

// DELETE documento
app.delete('/documentos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const usuarioId = extraerUsuarioId(req);

    if (!usuarioId) {
      return res.status(401).json({
        success: false,
        error: 'Debes iniciar sesion para eliminar documentos.'
      });
    }

    const { data: documento, error: findError } = await supabase
      .from('documentos')
      .select('url, nombre')
      .eq('id', id)
      .eq('usuario_id', usuarioId)
      .single();

    if (findError || !documento) {
      return res.status(404).json({
        success: false,
        error: 'No encontramos el documento que quieres eliminar.'
      });
    }

    const fileName = documento.url.split('/').pop();

    if (fileName) {
      await supabase.storage.from(BUCKET_NAME).remove([fileName]);
    }

    const { error: deleteError } = await supabase
      .from('documentos')
      .delete()
      .eq('id', id)
      .eq('usuario_id', usuarioId);

    if (deleteError) {
      console.error('Error al eliminar documento:', deleteError);
      return res.status(500).json({
        success: false,
        error: 'No pudimos eliminar el documento.'
      });
    }

    res.json({
      success: true,
      message: `"${documento.nombre}" eliminado correctamente.`
    });

  } catch (error) {
    console.error('Error en DELETE /documentos/:id:', error);
    res.status(500).json({
      success: false,
      error: 'Error al eliminar el documento.'
    });
  }
});

// ==================== 404 PARA RUTAS NO ENCONTRADAS ====================
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'No encontramos lo que buscas.'
  });
});

// ==================== MANEJO DE ERRORES (SIEMPRE AL FINAL) ====================
app.use((err, req, res, next) => {
  console.error('Error capturado:', err);

  if (err instanceof multer.MulterError) {
    console.log('Error de Multer:', err.code);

    const mensajes = {
      'LIMIT_FILE_SIZE': 'El archivo es demasiado pesado. El limite es 50 MB.',
      'LIMIT_UNEXPECTED_FILE': 'Hubo un problema con el archivo enviado. Intenta de nuevo.',
      'LIMIT_FIELD_COUNT': 'Se envio demasiada informacion. Intenta de nuevo.',
      'LIMIT_PART_COUNT': 'El archivo tiene un formato no compatible.'
    };

    return res.status(400).json({
      success: false,
      error: mensajes[err.code] || 'Hubo un problema al subir el archivo. Intenta de nuevo.'
    });
  }

  if (err.type === 'entity.too.large') {
    return res.status(413).json({
      success: false,
      error: 'El archivo o los datos enviados son demasiado grandes.'
    });
  }

  res.status(500).json({
    success: false,
    error: 'Algo salio mal en el servidor. Intenta de nuevo en un momento.'
  });
});

// ==================== INICIAR ====================
app.listen(PORT, () => {
  console.log(`Documentos service running on port ${PORT}`);
  console.log(`CORS permitido para: ${frontendUrl}`);
  console.log(`Tamano maximo: 50MB`);
});

module.exports = app;
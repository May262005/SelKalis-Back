const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const jwt = require('jsonwebtoken');
const supabase = require('./db');

require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const app = express();
const PORT = process.env.DOCUMENTOS_PORT || 3005;

// ==================== VALIDACIÓN DE VARIABLES ====================
if (!process.env.JWT_SECRET) {
  console.error('ERROR: JWT_SECRET no está definido en .env');
  process.exit(1);
}

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
  
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Max-Age', '86400');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  next();
});

// ==================== CONFIGURACIÓN DE LÍMITES ====================
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// ==================== CONFIGURACIÓN MULTER ====================
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 50 * 1024 * 1024,
    fieldSize: 50 * 1024 * 1024,
    files: 1
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

// ==================== EXTRAER USUARIO DEL TOKEN ====================
function extraerUsuarioId(req) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return null;
    }

    const token = authHeader.split(' ')[1];
    if (!token) {
      return null;
    }

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      return decoded.id;
    } catch (verifyError) {
      return null;
    }
  } catch (error) {
    return null;
  }
}

// ==================== MIDDLEWARE DE MANEJO DE ERRORES ====================
app.use((err, req, res, next) => {
  console.error('Error capturado:', err);
  
  if (err instanceof multer.MulterError) {
    if (err.code === 'FILE_TOO_LARGE') {
      return res.status(413).json({
        success: false,
        error: 'El archivo es demasiado grande. El tamaño máximo permitido es de 50 MB.'
      });
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({
        success: false,
        error: 'El campo del archivo debe llamarse "file". Verifica que estás enviando el archivo correctamente.'
      });
    }
    return res.status(400).json({
      success: false,
      error: `Error al subir el archivo: ${err.message}`
    });
  }
  next(err);
});

// ==================== ENDPOINTS ====================

// HEALTH CHECK
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    service: 'documentos-service',
    timestamp: new Date().toISOString()
  });
});

// GET /documentos - Listar documentos
app.get('/documentos', async (req, res) => {
  try {
    const usuarioId = extraerUsuarioId(req);
    
    if (!usuarioId) {
      return res.status(401).json({
        success: false,
        error: 'Debes iniciar sesión para ver tus documentos.'
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
        error: 'No pudimos cargar tus documentos. Intenta de nuevo más tarde.'
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
      error: 'Ocurrió un error al cargar tus documentos.'
    });
  }
});

// GET /documentos/:id - Obtener documento
app.get('/documentos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const usuarioId = extraerUsuarioId(req);
    
    if (!usuarioId) {
      return res.status(401).json({
        success: false,
        error: 'Debes iniciar sesión para ver este documento.'
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

// GET /documentos/:id/descargar - Descargar documento
app.get('/documentos/:id/descargar', async (req, res) => {
  try {
    const { id } = req.params;
    const usuarioId = extraerUsuarioId(req);
    
    if (!usuarioId) {
      return res.status(401).json({
        success: false,
        error: 'Debes iniciar sesión para descargar este documento.'
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

// POST /documentos/upload - Subir documento
app.post('/documentos/upload', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    const { nombre, categoria, descripcion } = req.body;
    const usuarioId = extraerUsuarioId(req);
    
    if (!usuarioId) {
      return res.status(401).json({
        success: false,
        error: 'Debes iniciar sesión para subir documentos.'
      });
    }

    if (!file) {
      return res.status(400).json({
        success: false,
        error: 'Selecciona un archivo para subir.'
      });
    }

    if (!nombre || nombre.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'Escribe un nombre para el documento.'
      });
    }

    // Validar tamaño
    if (file.size > 50 * 1024 * 1024) {
      return res.status(413).json({
        success: false,
        error: `El archivo pesa ${formatearTamano(file.size)}. El límite máximo es 50 MB.`
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
        error: `El tipo de archivo "${file.mimetype}" no está permitido. Sube imágenes, PDF, Word, Excel o texto.`
      });
    }

    const fileName = `${Date.now()}_${file.originalname}`;

    // Subir a Supabase
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from(BUCKET_NAME)
      .upload(fileName, file.buffer, {
        contentType: file.mimetype,
        cacheControl: '3600',
        upsert: false,
      });

    if (uploadError) {
      console.error('Error al subir archivo:', uploadError);
      return res.status(500).json({
        success: false,
        error: 'No pudimos subir tu archivo. Intenta de nuevo.'
      });
    }

    // Obtener URL pública
    const { data: urlData } = supabase.storage
      .from(BUCKET_NAME)
      .getPublicUrl(fileName);
    const publicUrl = urlData.publicUrl;

    // Guardar metadata
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
        error: 'El archivo se subió pero no pudimos guardar la información.'
      });
    }

    res.json({
      success: true,
      message: '¡Documento subido con éxito!',
      data: {
        ...documento,
        tamano: formatearTamano(documento.tamano)
      }
    });

  } catch (error) {
    console.error('Error en POST /documentos/upload:', error);
    res.status(500).json({
      success: false,
      error: 'Error al subir el archivo. Intenta de nuevo.'
    });
  }
});

// DELETE /documentos/:id - Eliminar documento
app.delete('/documentos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const usuarioId = extraerUsuarioId(req);
    
    if (!usuarioId) {
      return res.status(401).json({
        success: false,
        error: 'Debes iniciar sesión para eliminar documentos.'
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

// ==================== INICIAR SERVIDOR ====================
app.listen(PORT, () => {
  console.log(`Documentos service running on port ${PORT}`);
  console.log(`Bucket: ${BUCKET_NAME}`);
  console.log(`CORS permitido para: ${frontendUrl}`);
  console.log(`Tamaño máximo: 50MB`);
});

module.exports = app;
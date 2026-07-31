const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const supabase = require('./db');

require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const app = express();
const PORT = process.env.DOCUMENTOS_PORT || 3005;

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

// ==================== CONFIGURACIÓN MULTER ====================
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB
  }
});

// ==================== BUCKET ====================
const BUCKET_NAME = 'documentos';

// Crear bucket si no existe
async function crearBucketSiNoExiste() {
  try {
    const { data: buckets, error } = await supabase.storage.listBuckets();
    
    if (error) {
      console.error('Error al listar buckets:', error);
      return;
    }

    const bucketExiste = buckets?.some(b => b.name === BUCKET_NAME);
    
    if (!bucketExiste) {
      const { error: createError } = await supabase.storage.createBucket(
        BUCKET_NAME,
        {
          public: true,
          fileSizeLimit: 10485760, // 10MB
        }
      );
      
      if (createError) {
        console.error('Error al crear bucket:', createError);
      } else {
        console.log(`✅ Bucket "${BUCKET_NAME}" creado correctamente`);
      }
    } else {
      console.log(`✅ Bucket "${BUCKET_NAME}" ya existe`);
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
    // Obtener token del header Authorization
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      console.log('⚠️ No hay token de autenticación');
      return null;
    }

    const token = authHeader.split(' ')[1];
    if (!token) {
      console.log('⚠️ Token no encontrado en el header');
      return null;
    }

    // Decodificar el token JWT (sin verificar, solo extraer payload)
    try {
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
      console.log('✅ Usuario autenticado:', payload.id || payload.sub);
      return payload.id || payload.sub;
    } catch (decodeError) {
      console.error('❌ Error decodificando token:', decodeError.message);
      return null;
    }
  } catch (error) {
    console.error('❌ Error extrayendo usuario:', error.message);
    return null;
  }
}

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
        error: 'Usuario no autenticado'
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
        error: 'Error al obtener los documentos'
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
      error: 'Error interno del servidor'
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
        error: 'Usuario no autenticado'
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
        error: 'Documento no encontrado'
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
      error: 'Error interno del servidor'
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
        error: 'Usuario no autenticado'
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
        error: 'Documento no encontrado'
      });
    }

    res.redirect(data.url);

  } catch (error) {
    console.error('Error en GET /documentos/:id/descargar:', error);
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor'
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
        error: 'Usuario no autenticado'
      });
    }

    if (!file) {
      return res.status(400).json({
        success: false,
        error: 'No se ha subido ningún archivo'
      });
    }

    if (!nombre) {
      return res.status(400).json({
        success: false,
        error: 'El nombre del documento es requerido'
      });
    }

    const fileName = `${Date.now()}_${file.originalname}`;

    // Subir archivo a Supabase Storage
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
        error: 'Error al subir el archivo'
      });
    }

    // Obtener URL pública
    const { data: urlData } = supabase.storage
      .from(BUCKET_NAME)
      .getPublicUrl(fileName);

    const publicUrl = urlData.publicUrl;

    // Guardar metadata en la base de datos
    const { data: documento, error: dbError } = await supabase
      .from('documentos')
      .insert({
        nombre: nombre,
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
      // Intentar eliminar el archivo subido
      await supabase.storage.from(BUCKET_NAME).remove([fileName]);
      return res.status(500).json({
        success: false,
        error: 'Error al guardar la información del documento'
      });
    }

    res.json({
      success: true,
      message: 'Documento subido correctamente',
      data: {
        ...documento,
        tamano: formatearTamano(documento.tamano)
      }
    });

  } catch (error) {
    console.error('Error en POST /documentos/upload:', error);
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor'
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
        error: 'Usuario no autenticado'
      });
    }

    // Obtener el documento primero para saber el nombre del archivo
    const { data: documento, error: findError } = await supabase
      .from('documentos')
      .select('url')
      .eq('id', id)
      .eq('usuario_id', usuarioId)
      .single();

    if (findError || !documento) {
      return res.status(404).json({
        success: false,
        error: 'Documento no encontrado'
      });
    }

    // Extraer el nombre del archivo de la URL
    const fileName = documento.url.split('/').pop();

    // Eliminar el archivo de Storage
    if (fileName) {
      await supabase.storage.from(BUCKET_NAME).remove([fileName]);
    }

    // Eliminar el registro de la base de datos
    const { error: deleteError } = await supabase
      .from('documentos')
      .delete()
      .eq('id', id)
      .eq('usuario_id', usuarioId);

    if (deleteError) {
      console.error('Error al eliminar documento:', deleteError);
      return res.status(500).json({
        success: false,
        error: 'Error al eliminar el documento'
      });
    }

    res.json({
      success: true,
      message: 'Documento eliminado correctamente'
    });

  } catch (error) {
    console.error('Error en DELETE /documentos/:id:', error);
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor'
    });
  }
});

// ==================== INICIAR SERVIDOR ====================
app.listen(PORT, () => {
  console.log(`✅ Documentos service running on port ${PORT}`);
  console.log(`📁 Bucket: ${BUCKET_NAME}`);
  console.log(`🔑 Health check: http://localhost:${PORT}/health`);
  console.log(`📄 Documentos: http://localhost:${PORT}/documentos`);
});

module.exports = app;
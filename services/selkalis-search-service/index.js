// index.js
const express = require('express');
const cors = require('cors');
const { Client } = require('@elastic/elasticsearch');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3006;

// ==================== CONFIGURACIÓN DE ELASTICSEARCH ====================
// Usa las credenciales de Elastic Cloud
const esClient = new Client({
  node: process.env.ELASTICSEARCH_URL,
  auth: {
    apiKey: process.env.ELASTICSEARCH_API_KEY
    // O usa usuario/contraseña:
    // username: process.env.ELASTICSEARCH_USER,
    // password: process.env.ELASTICSEARCH_PASSWORD
  }
});

// ==================== MIDDLEWARE ====================
app.use(cors({
  origin: ['https://selkalis.vercel.app', 'http://localhost:4200'],
  credentials: true
}));
app.use(express.json());

// ==================== VERIFICAR TOKEN ====================
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
  res.json({ status: 'OK', service: 'search-service' });
});

// ==================== ENDPOINTS DE BÚSQUEDA ====================

// BÚSQUEDA EN UN MÓDULO ESPECÍFICO
app.post('/search/modulo', verifyToken, async (req, res) => {
  try {
    const { modulo, termino, filtros = {} } = req.body;
    const usuarioId = req.usuario_id;

    console.log(`🔍 Buscando en ${modulo}: "${termino}" (usuario: ${usuarioId})`);

    // Definir qué campos buscar según el módulo
    const camposPorModulo = {
      citas: ['titulo^3', 'especialidad^2', 'lugar', 'notas'],
      tratamientos: ['nombre^3', 'diagnostico^2', 'notas'],
      medicamentos: ['nombre^3', 'concentracion', 'dosis', 'instrucciones', 'tratamiento_nombre^2'],
      estudios: ['titulo^3', 'tipo^2', 'lugar', 'descripcion'],
      documentos: ['nombre^3', 'categoria', 'descripcion']
    };

    const campos = camposPorModulo[modulo] || ['*'];

    // Construir la consulta
    const query = {
      bool: {
        must: [
          {
            multi_match: {
              query: termino,
              fields: campos,
              fuzziness: 'AUTO',
              type: 'best_fields'
            }
          },
          {
            term: {
              usuario_id: usuarioId
            }
          }
        ]
      }
    };

    // Agregar filtros si existen
    if (Object.keys(filtros).length > 0) {
      query.bool.filter = [];
      for (const [key, value] of Object.entries(filtros)) {
        query.bool.filter.push({ term: { [key]: value } });
      }
    }

    // Ejecutar búsqueda
    const index = `selkalis_${modulo}`;
    const results = await esClient.search({
      index,
      body: {
        query,
        size: 50,
        highlight: {
          fields: {
            'titulo': { number_of_fragments: 1 },
            'nombre': { number_of_fragments: 1 },
            'diagnostico': { number_of_fragments: 1 }
          }
        }
      }
    });

    // Transformar resultados
    const resultados = results.hits.hits.map(hit => {
      const source = hit._source;
      return {
        id: hit._id,
        tipo: modulo,
        titulo: source.titulo || source.nombre || 'Sin título',
        descripcion: source.diagnostico || source.especialidad || source.notas || '',
        fecha: source.fecha || source.fecha_inicio,
        estado: source.estado,
        relevancia: hit._score,
        highlight: hit.highlight || {},
        datos: source
      };
    });

    res.json({
      success: true,
      data: {
        total: results.hits.total.value,
        resultados
      }
    });

  } catch (error) {
    console.error('❌ Error en búsqueda:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// BÚSQUEDA GLOBAL (todos los módulos)
app.post('/search/global', verifyToken, async (req, res) => {
  try {
    const { termino, limite = 20 } = req.body;
    const usuarioId = req.usuario_id;

    console.log(`🔍 Búsqueda global: "${termino}" (usuario: ${usuarioId})`);

    const results = await esClient.search({
      index: 'selkalis_*',
      body: {
        query: {
          bool: {
            must: [
              {
                multi_match: {
                  query: termino,
                  fields: ['*'],
                  fuzziness: 'AUTO',
                  type: 'best_fields'
                }
              },
              {
                term: {
                  usuario_id: usuarioId
                }
              }
            ]
          }
        },
        size: limite
      }
    });

    const resultados = results.hits.hits.map(hit => {
      const source = hit._source;
      const tipo = hit._index.replace('selkalis_', '');
      return {
        id: hit._id,
        tipo: tipo,
        titulo: source.titulo || source.nombre || 'Sin título',
        descripcion: source.diagnostico || source.especialidad || source.notas || '',
        fecha: source.fecha || source.fecha_inicio,
        estado: source.estado,
        relevancia: hit._score,
        datos: source
      };
    });

    res.json({
      success: true,
      data: {
        total: results.hits.total.value,
        resultados
      }
    });

  } catch (error) {
    console.error('❌ Error en búsqueda global:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// INDEXAR DOCUMENTO
app.post('/search/indexar', verifyToken, async (req, res) => {
  try {
    const { modulo, documento } = req.body;
    const usuarioId = req.usuario_id;

    const index = `selkalis_${modulo}`;

    await esClient.index({
      index,
      id: documento.id,
      body: {
        ...documento,
        usuario_id: usuarioId,
        fecha_indexacion: new Date().toISOString()
      }
    });

    console.log(`✅ Indexado en ${modulo}: ${documento.id}`);
    res.json({ success: true, message: 'Documento indexado correctamente' });

  } catch (error) {
    console.error('❌ Error indexando:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ELIMINAR DOCUMENTO
app.delete('/search/:modulo/:id', verifyToken, async (req, res) => {
  try {
    const { modulo, id } = req.params;
    const index = `selkalis_${modulo}`;

    await esClient.delete({
      index,
      id
    });

    console.log(`🗑️ Eliminado de ${modulo}: ${id}`);
    res.json({ success: true, message: 'Documento eliminado' });

  } catch (error) {
    console.error('❌ Error eliminando:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ==================== INICIAR SERVIDOR ====================
app.listen(PORT, () => {
  console.log(`🚀 Search Service running on port ${PORT}`);
});
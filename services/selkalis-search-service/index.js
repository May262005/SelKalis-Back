const express = require('express');
const cors = require('cors');
const { Client } = require('@elastic/elasticsearch');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3006;

const esClient = new Client({
  node: process.env.ELASTICSEARCH_URL,
  auth: {
    apiKey: process.env.ELASTICSEARCH_API_KEY
  }
});

app.use(cors({
  origin: ['https://selkalis.vercel.app', 'https://sselkalis.vercel.app', 'http://localhost:4200'],
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Timezone']
}));
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

// ✅ Normaliza términos con letras repetidas
function normalizarTermino(termino) {
  if (!termino) return termino;
  return termino.replace(/(.)\1{2,}/g, '$1$1');
}

// ✅ FIX: el wildcard de Elasticsearch NO analiza el texto (no lo pasa por el
// analizador que pone todo en minúsculas y quita acentos). Si buscas "Dr" con
// mayúscula pero el índice guardó el token en minúsculas ("dr"), el wildcard
// nunca hace match. Por eso normalizamos a minúsculas y sin acentos aquí mismo,
// para que el wildcard compare "manzana con manzana".
function normalizarParaWildcard(termino) {
  if (!termino) return termino;
  return termino
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, ''); // quita acentos/diacríticos
}

app.get('/health', (req, res) => {
  res.json({ status: 'OK', service: 'search-service' });
});

// ==================== BÚSQUEDA TOLERANTE ====================
app.post('/search/modulo', verifyToken, async (req, res) => {
  try {
    const { modulo, filtros = {} } = req.body;
    const usuarioId = req.usuario_id;

    const terminoOriginal = req.body.termino;
    const termino = normalizarTermino(terminoOriginal);
    const terminoWildcard = normalizarParaWildcard(termino);

    console.log(`🔍 Buscando en ${modulo}: "${terminoOriginal}" (normalizado: "${termino}", wildcard: "${terminoWildcard}") (usuario: ${usuarioId})`);

    const camposPorModulo = {
      citas: ['titulo', 'especialidad', 'lugar', 'notas'],
      tratamientos: ['nombre', 'diagnostico', 'notas'],
      medicamentos: ['nombre', 'concentracion', 'dosis', 'instrucciones', 'tratamiento_nombre'],
      estudios: ['titulo', 'tipo', 'lugar', 'descripcion'],
      documentos: ['nombre', 'categoria', 'descripcion']
    };

    const campos = camposPorModulo[modulo] || ['*'];

    const shouldQueries = [];

    // 1. Fuzzy search con fuzziness "AUTO" - operador 'or' para que coincida con ALGUNA palabra
    for (const campo of campos) {
      shouldQueries.push({
        match: {
          [campo]: {
            query: termino,
            fuzziness: 'AUTO',
            prefix_length: 1,
            operator: 'or',
            boost: 3
          }
        }
      });
    }

    // 2. Coincidencia parcial con wildcard - ✅ AHORA usa el término normalizado
    //    (minúsculas, sin acentos) para que sí matchee contra los tokens indexados.
    for (const campo of campos) {
      shouldQueries.push({
        wildcard: {
          [campo]: {
            value: `*${terminoWildcard}*`,
            case_insensitive: true, // por si acaso, doble seguro (ES >= 7.10)
            boost: 2
          }
        }
      });
    }

    // 3. Coincidencia exacta
    for (const campo of campos) {
      shouldQueries.push({
        match: {
          [campo]: {
            query: termino,
            operator: 'or',
            boost: 5
          }
        }
      });
    }

    // 4. ✅ Autocompletado / búsqueda por prefijo o fragmento (ej. "Tit" -> "Tito")
    //    Usa el sub-campo .autocomplete (edge n-grams). No requiere fuzziness porque
    //    ya resuelve el caso de "escribí solo una parte del nombre".
    //    Requiere que el índice tenga el mapping con .autocomplete (ver PUT del índice).
    for (const campo of campos) {
      shouldQueries.push({
        match: {
          [`${campo}.autocomplete`]: {
            query: termino,
            operator: 'or',
            boost: 4
          }
        }
      });
    }

    const query = {
      bool: {
        must: [
          {
            term: {
              usuario_id: usuarioId
            }
          }
        ],
        should: shouldQueries,
        minimum_should_match: 1
      }
    };

    if (Object.keys(filtros).length > 0) {
      query.bool.filter = [];
      for (const [key, value] of Object.entries(filtros)) {
        query.bool.filter.push({ term: { [key]: value } });
      }
    }

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

    console.log(`   ↳ ${results.hits.total.value} resultado(s) encontrados en ${index}`);

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

// ==================== BÚSQUEDA GLOBAL ====================
app.post('/search/global', verifyToken, async (req, res) => {
  try {
    const { limite = 20 } = req.body;
    const usuarioId = req.usuario_id;

    const terminoOriginal = req.body.termino;
    const termino = normalizarTermino(terminoOriginal);
    const terminoWildcard = normalizarParaWildcard(termino);

    console.log(`🔍 Búsqueda global: "${terminoOriginal}" (normalizado: "${termino}", wildcard: "${terminoWildcard}") (usuario: ${usuarioId})`);

    const results = await esClient.search({
      index: 'selkalis_*',
      body: {
        query: {
          bool: {
            must: [
              {
                term: {
                  usuario_id: usuarioId
                }
              }
            ],
            should: [
              {
                multi_match: {
                  query: termino,
                  fields: ['*'],
                  fuzziness: 'AUTO',
                  prefix_length: 1,
                  operator: 'or',
                  boost: 3
                }
              },
              {
                wildcard: {
                  titulo: {
                    value: `*${terminoWildcard}*`,
                    case_insensitive: true,
                    boost: 2
                  }
                }
              },
              {
                wildcard: {
                  nombre: {
                    value: `*${terminoWildcard}*`,
                    case_insensitive: true,
                    boost: 2
                  }
                }
              }
            ],
            minimum_should_match: 1
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

// ==================== INDEXAR ====================
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

    console.log(`✅ Indexado en ${modulo}: ${documento.id} (usuario: ${usuarioId})`);
    res.json({ success: true, message: 'Documento indexado correctamente' });

  } catch (error) {
    console.error('❌ Error indexando:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ==================== ELIMINAR ====================
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

// ==================== CREAR ÍNDICES ====================
// ✅ FIX: el analizador "spanish" de Elasticsearch NO incluye asciifolding,
// es decir "González" se indexa como "gonzález" (con acento) y NO como
// "gonzalez". Esto hacía fallar búsquedas sin acento en casos límite.
// Ahora usamos un analizador personalizado que: minúsculas -> quita acentos
// -> aplica el stemmer español -> quita stopwords en español.
// ✅ Helper: define un campo de texto con su sub-campo .autocomplete (edge n-grams).
// Esto es lo que permite que CUALQUIER palabra en CUALQUIER campo de texto se pueda
// buscar por fragmento/prefijo (ej. "Tit" encuentra "Tito", "Garc" encuentra "Garcia"),
// de forma genérica, sin tener que anticipar nombres o palabras específicas.
function campoTextoConAutocomplete() {
  return {
    type: 'text',
    analyzer: 'spanish_analyzer',
    fields: {
      autocomplete: {
        type: 'text',
        analyzer: 'autocomplete_index_analyzer',
        search_analyzer: 'autocomplete_search_analyzer'
      }
    }
  };
}

const ANALYSIS_SETTINGS = {
  filter: {
    spanish_stop: {
      type: 'stop',
      stopwords: '_spanish_'
    },
    spanish_stemmer: {
      type: 'stemmer',
      language: 'light_spanish'
    },
    autocomplete_filter: {
      type: 'edge_ngram',
      min_gram: 2,
      max_gram: 20
    }
  },
  analyzer: {
    spanish_analyzer: {
      type: 'custom',
      tokenizer: 'standard',
      filter: [
        'lowercase',
        'asciifolding', // ✅ quita acentos: "González" -> "gonzalez"
        'spanish_stop',
        'spanish_stemmer'
      ]
    },
    autocomplete_index_analyzer: {
      type: 'custom',
      tokenizer: 'standard',
      filter: ['lowercase', 'asciifolding', 'autocomplete_filter']
    },
    autocomplete_search_analyzer: {
      type: 'custom',
      tokenizer: 'standard',
      filter: ['lowercase', 'asciifolding']
    }
  }
};

// ✅ Mapping por índice, usando campoTextoConAutocomplete() en TODOS los campos
// de texto libre (no solo título/nombre) para que la búsqueda por fragmento
// funcione en cualquier campo, para cualquier módulo.
const MAPPINGS_POR_INDICE = {
  citas: {
    id: { type: 'keyword' },
    usuario_id: { type: 'keyword' },
    titulo: campoTextoConAutocomplete(),
    especialidad: campoTextoConAutocomplete(),
    fecha: { type: 'date' },
    hora: { type: 'keyword' },
    tipo: { type: 'keyword' },
    lugar: campoTextoConAutocomplete(),
    notas: campoTextoConAutocomplete(),
    estado: { type: 'keyword' },
    created_at: { type: 'date' },
    updated_at: { type: 'date' },
    fecha_indexacion: { type: 'date' }
  },
  tratamientos: {
    id: { type: 'keyword' },
    usuario_id: { type: 'keyword' },
    nombre: campoTextoConAutocomplete(),
    diagnostico: campoTextoConAutocomplete(),
    fecha_inicio: { type: 'date' },
    fecha_fin: { type: 'date' },
    notas: campoTextoConAutocomplete(),
    estado: { type: 'keyword' },
    activo: { type: 'boolean' },
    created_at: { type: 'date' },
    updated_at: { type: 'date' },
    fecha_indexacion: { type: 'date' }
  },
  medicamentos: {
    id: { type: 'keyword' },
    usuario_id: { type: 'keyword' },
    nombre: campoTextoConAutocomplete(),
    concentracion: campoTextoConAutocomplete(),
    dosis: campoTextoConAutocomplete(),
    frecuencia: { type: 'keyword' },
    duracion_dias: { type: 'integer' },
    instrucciones: campoTextoConAutocomplete(),
    tratamiento_id: { type: 'keyword' },
    tratamiento_nombre: campoTextoConAutocomplete(),
    activo: { type: 'boolean' },
    created_at: { type: 'date' },
    updated_at: { type: 'date' },
    fecha_indexacion: { type: 'date' }
  },
  estudios: {
    id: { type: 'keyword' },
    usuario_id: { type: 'keyword' },
    titulo: campoTextoConAutocomplete(),
    tipo: campoTextoConAutocomplete(),
    fecha: { type: 'date' },
    hora: { type: 'keyword' },
    lugar: campoTextoConAutocomplete(),
    notas: campoTextoConAutocomplete(),
    estado: { type: 'keyword' },
    created_at: { type: 'date' },
    updated_at: { type: 'date' },
    fecha_indexacion: { type: 'date' }
  },
  documentos: {
    id: { type: 'keyword' },
    usuario_id: { type: 'keyword' },
    nombre: campoTextoConAutocomplete(),
    categoria: { type: 'keyword' },
    descripcion: campoTextoConAutocomplete(),
    tipo: { type: 'keyword' },
    url: { type: 'keyword' },
    tamano: { type: 'keyword' },
    created_at: { type: 'date' },
    updated_at: { type: 'date' },
    fecha_indexacion: { type: 'date' }
  }
};

async function crearIndices() {
  const indices = ['citas', 'tratamientos', 'medicamentos', 'estudios', 'documentos'];

  for (const idx of indices) {
    const indexName = `selkalis_${idx}`;

    try {
      const exists = await esClient.indices.exists({ index: indexName });

      if (!exists) {
        await esClient.indices.create({
          index: indexName,
          body: {
            settings: {
              analysis: ANALYSIS_SETTINGS
            },
            mappings: {
              properties: MAPPINGS_POR_INDICE[idx]
            }
          }
        });
        console.log(`✅ Índice ${indexName} creado correctamente`);
      } else {
        console.log(`✅ Índice ${indexName} ya existe`);
      }
    } catch (error) {
      console.error(`❌ Error creando ${indexName}:`, error);
    }
  }
}

crearIndices();

app.listen(PORT, () => {
  console.log(`🚀 Search Service running on port ${PORT}`);
});
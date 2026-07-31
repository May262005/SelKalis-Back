const express = require('express');
const cors = require('cors');
const { createProxyMiddleware } = require('http-proxy-middleware');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// URLs de los microservicios
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';
const TRATAMIENTOS_SERVICE_URL = process.env.TRATAMIENTOS_SERVICE_URL || 'http://localhost:3002';
const CITAS_SERVICE_URL = process.env.CITAS_SERVICE_URL || 'http://localhost:3003';
const ESTUDIOS_SERVICE_URL = process.env.ESTUDIOS_SERVICE_URL || 'http://localhost:3004';

const allowedOrigins = (process.env.FRONTEND_URL || 'http://localhost:4200')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'OK', service: 'api-gateway' });
});

// ==================== FUNCIÓN PARA DESPERTAR SERVICIO ====================
async function despertarServicio(url, intentos = 3, esperaMs = 5000) {
  for (let i = 1; i <= intentos; i++) {
    try {
      console.log(`[despertar] Intentando ${url} (intento ${i}/${intentos})`);
      const respuesta = await fetch(url, {
        signal: AbortSignal.timeout(10000),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': '*/*'
        }
      });
      
      if (respuesta.ok) {
        console.log(`[despertar] ✅ ${url} despierto después de ${i} intentos`);
        return true;
      }
    } catch (err) {
      console.log(`[despertar] ⏳ ${url} intento ${i} falló: ${err.message}`);
    }
    
    if (i < intentos) {
      await new Promise(resolve => setTimeout(resolve, esperaMs * i));
    }
  }
  
  console.log(`[despertar] ❌ ${url} no pudo despertarse después de ${intentos} intentos`);
  return false;
}

// ==================== MIDDLEWARE DE REINTENTO ====================
function crearProxyConReintento(targetUrl, pathRewrite, nombreServicio) {
  return async function(req, res, next) {
    let intentos = 0;
    const maxIntentos = 3;
    let ultimoError = null;
    
    while (intentos < maxIntentos) {
      intentos++;
      console.log(`[proxy] ${nombreServicio} - Intento ${intentos}/${maxIntentos} para ${req.method} ${req.path}`);
      
      try {
        // Construir la URL del servicio
        const targetPath = req.path.replace('/api', '');
        const url = `${targetUrl}${targetPath}`;
        
        // Hacer fetch directamente (simulando proxy)
        const fetchOptions = {
          method: req.method,
          headers: {
            'Content-Type': 'application/json',
            ...req.headers
          },
          signal: AbortSignal.timeout(60000)
        };
        
        // Si hay cuerpo, incluir
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          fetchOptions.body = JSON.stringify(req.body);
        }
        
        // Eliminar headers que causan problemas
        delete fetchOptions.headers.host;
        delete fetchOptions.headers['content-length'];
        
        const response = await fetch(url, fetchOptions);
        
        // Si el servicio responde bien (incluso 404, etc), pasamos la respuesta
        const data = await response.text();
        res.status(response.status);
        res.set('Content-Type', response.headers.get('content-type') || 'application/json');
        res.send(data);
        return; // Éxito, salimos de la función
        
      } catch (err) {
        ultimoError = err;
        console.log(`[proxy] ${nombreServicio} - Intento ${intentos} falló: ${err.message}`);
        
        // Si es el último intento, devolvemos 502
        if (intentos >= maxIntentos) {
          console.log(`[proxy] ${nombreServicio} - Todos los intentos fallaron`);
          res.status(502).json({ 
            error: `Error en el servicio de ${nombreServicio}`,
            mensaje: err.message,
            intentos: maxIntentos
          });
          return;
        }
        
        // Intentar despertar el servicio antes del siguiente intento
        console.log(`[proxy] ${nombreServicio} - Intentando despertar servicio...`);
        const despierto = await despertarServicio(`${targetUrl}/health`);
        if (despierto) {
          console.log(`[proxy] ${nombreServicio} - Servicio despierto, reintentando...`);
        } else {
          console.log(`[proxy] ${nombreServicio} - No se pudo despertar el servicio`);
        }
        
        // Esperar antes del siguiente intento
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  };
}

// ==================== RUTAS CON REINTENTO ====================
app.use('/api/usuarios', crearProxyConReintento(
  AUTH_SERVICE_URL, 
  '/usuarios',
  'autenticación'
));

app.use('/api/auth', crearProxyConReintento(
  AUTH_SERVICE_URL,
  '/auth',
  'autenticación'
));

app.use('/api/tratamientos', crearProxyConReintento(
  TRATAMIENTOS_SERVICE_URL,
  '/tratamientos',
  'tratamientos'
));

app.use('/api/medicamentos', crearProxyConReintento(
  TRATAMIENTOS_SERVICE_URL,
  '/medicamentos',
  'tratamientos'
));

app.use('/api/citas', crearProxyConReintento(
  CITAS_SERVICE_URL,
  '/citas',
  'citas'
));

app.use('/api/estudios', crearProxyConReintento(
  ESTUDIOS_SERVICE_URL,
  '/estudios',
  'estudios'
));

// ==================== KEEP-ALIVE (mantener activo) ====================
function esperar(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function pingConReintentos(url, intentos = 9, esperaMs = 10000) {
  let ultimoError = null;
  for (let i = 1; i <= intentos; i++) {
    const inicio = Date.now();
    try {
      const respuesta = await fetch(url, {
        signal: AbortSignal.timeout(15000),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/html,application/json,*/*'
        }
      });
      const ms = Date.now() - inicio;
      console.log(`[keep-alive] ${url} intento ${i}/${intentos} -> status ${respuesta.status} (${ms}ms)`);
      if (respuesta.ok) return 'awake';
      ultimoError = `error ${respuesta.status}`;
    } catch (err) {
      const ms = Date.now() - inicio;
      console.log(`[keep-alive] ${url} intento ${i}/${intentos} -> excepcion "${err.message}" (${ms}ms)`);
      ultimoError = `unreachable (${err.message})`;
    }
    if (i < intentos) await esperar(esperaMs);
  }
  return `failed after ${intentos} intentos: ${ultimoError}`;
}

app.get('/api/keep-alive', async (req, res) => {
  const targets = {
    auth: `${AUTH_SERVICE_URL}/health`,
    tratamientos: `${TRATAMIENTOS_SERVICE_URL}/health`,
    citas: `${CITAS_SERVICE_URL}/health`,
    estudios: `${ESTUDIOS_SERVICE_URL}/estudios/health`
  };

  const resultados = {};

  await Promise.all(
    Object.entries(targets).map(async ([nombre, url]) => {
      resultados[nombre] = await pingConReintentos(url);
    })
  );

  res.json({
    gateway: 'awake',
    timestamp: new Date().toISOString(),
    servicios: resultados
  });
});

app.listen(PORT, () => {
  console.log(`✅ API Gateway running on port ${PORT}`);
  console.log(`AUTH_SERVICE_URL: ${AUTH_SERVICE_URL}`);
  console.log(`TRATAMIENTOS_SERVICE_URL: ${TRATAMIENTOS_SERVICE_URL}`);
  console.log(`CITAS_SERVICE_URL: ${CITAS_SERVICE_URL}`);
  console.log(`ESTUDIOS_SERVICE_URL: ${ESTUDIOS_SERVICE_URL}`);
});
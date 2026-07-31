const express = require('express');
const cors = require('cors');
const { createProxyMiddleware } = require('http-proxy-middleware');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// URLs de los microservicios (en Render son https://xxx.onrender.com, en local localhost)
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';
const TRATAMIENTOS_SERVICE_URL = process.env.TRATAMIENTOS_SERVICE_URL || 'http://localhost:3002';
const CITAS_SERVICE_URL = process.env.CITAS_SERVICE_URL || 'http://localhost:3003';
const ESTUDIOS_SERVICE_URL = process.env.ESTUDIOS_SERVICE_URL || 'http://localhost:3004';

// Soporta uno o varios orígenes separados por coma en FRONTEND_URL
const allowedOrigins = (process.env.FRONTEND_URL || 'http://localhost:4200')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

app.use(cors({ origin: allowedOrigins, credentials: true }));

app.get('/health', (req, res) => {
  res.json({ status: 'OK', service: 'api-gateway' });
});

// ==================== KEEP-ALIVE (evita que los servicios se duerman) ====================
// Un cron externo (cron-job.org, UptimeRobot, etc.) llama a este endpoint cada ~10 min.
// Al recibir tráfico, este servicio (gateway) no se duerme, y al hacer ping a los otros
// 4 servicios, tampoco se duermen ellos.
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
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
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

// Timeout generoso para dar tiempo a que un servicio "dormido" en Render despierte
const PROXY_TIMEOUT_MS = 60000;

// ==================== PROXY PARA AUTH SERVICE ====================
app.use('/api/usuarios', createProxyMiddleware({
  target: AUTH_SERVICE_URL,
  changeOrigin: true,
  pathRewrite: { '^/api/usuarios': '/usuarios' },
  proxyTimeout: PROXY_TIMEOUT_MS,
  timeout: PROXY_TIMEOUT_MS,
  onError: (err, req, res) => {
    console.error('Proxy error (usuarios):', err.message);
    res.status(502).json({ error: 'Error en el servicio de autenticación', mensaje: err.message });
  }
}));

app.use('/api/auth', createProxyMiddleware({
  target: AUTH_SERVICE_URL,
  changeOrigin: true,
  pathRewrite: { '^/api/auth': '/auth' },
  proxyTimeout: PROXY_TIMEOUT_MS,
  timeout: PROXY_TIMEOUT_MS,
  onError: (err, req, res) => {
    console.error('Proxy error (auth):', err.message);
    res.status(502).json({ error: 'Error en el servicio de autenticación', mensaje: err.message });
  }
}));

// ==================== PROXY PARA TRATAMIENTOS SERVICE ====================
app.use('/api/tratamientos', createProxyMiddleware({
  target: TRATAMIENTOS_SERVICE_URL,
  changeOrigin: true,
  pathRewrite: { '^/api/tratamientos': '/tratamientos' },
  proxyTimeout: PROXY_TIMEOUT_MS,
  timeout: PROXY_TIMEOUT_MS,
  onError: (err, req, res) => {
    console.error('Proxy error (tratamientos):', err.message);
    res.status(502).json({ error: 'Error en el servicio de tratamientos', mensaje: err.message });
  }
}));

app.use('/api/medicamentos', createProxyMiddleware({
  target: TRATAMIENTOS_SERVICE_URL,
  changeOrigin: true,
  pathRewrite: { '^/api/medicamentos': '/medicamentos' },
  proxyTimeout: PROXY_TIMEOUT_MS,
  timeout: PROXY_TIMEOUT_MS,
  onError: (err, req, res) => {
    console.error('Proxy error (medicamentos):', err.message);
    res.status(502).json({ error: 'Error en el servicio de tratamientos', mensaje: err.message });
  }
}));

// ==================== PROXY PARA CITAS SERVICE ====================
app.use('/api/citas', createProxyMiddleware({
  target: CITAS_SERVICE_URL,
  changeOrigin: true,
  pathRewrite: { '^/api/citas': '/citas' },
  proxyTimeout: PROXY_TIMEOUT_MS,
  timeout: PROXY_TIMEOUT_MS,
  onError: (err, req, res) => {
    console.error('Proxy error (citas):', err.message);
    res.status(502).json({ error: 'Error en el servicio de citas', mensaje: err.message });
  }
}));

// ==================== PROXY PARA ESTUDIOS SERVICE ====================
app.use('/api/estudios', createProxyMiddleware({
  target: ESTUDIOS_SERVICE_URL,
  changeOrigin: true,
  pathRewrite: { '^/api/estudios': '/estudios' },
  proxyTimeout: PROXY_TIMEOUT_MS,
  timeout: PROXY_TIMEOUT_MS,
  onError: (err, req, res) => {
    console.error('Proxy error (estudios):', err.message);
    res.status(502).json({ error: 'Error en el servicio de estudios', mensaje: err.message });
  }
}));

app.listen(PORT, () => {
  console.log(`✅ API Gateway running on port ${PORT}`);
  console.log(`AUTH_SERVICE_URL: ${AUTH_SERVICE_URL}`);
  console.log(`TRATAMIENTOS_SERVICE_URL: ${TRATAMIENTOS_SERVICE_URL}`);
  console.log(`CITAS_SERVICE_URL: ${CITAS_SERVICE_URL}`);
  console.log(`ESTUDIOS_SERVICE_URL: ${ESTUDIOS_SERVICE_URL}`);
});
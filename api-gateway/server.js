const express = require('express');
const cors = require('cors');
const { createProxyMiddleware } = require('http-proxy-middleware');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: 'http://localhost:4200', credentials: true }));

app.get('/health', (req, res) => {
  res.json({ status: 'OK', service: 'api-gateway' });
});

// ==================== PROXY PARA AUTH SERVICE ====================
app.use('/api/usuarios', createProxyMiddleware({
  target: 'http://localhost:3001',
  changeOrigin: true,
  pathRewrite: { '^/api/usuarios': '/usuarios' },
  on: {
    error: (err, req, res) => {
      res.status(500).json({ error: 'Error en el servicio de autenticación', mensaje: err.message });
    }
  }
}));

app.use('/api/auth', createProxyMiddleware({
  target: 'http://localhost:3001',
  changeOrigin: true,
  pathRewrite: { '^/api/auth': '/auth' },
  on: {
    error: (err, req, res) => {
      res.status(500).json({ error: 'Error en el servicio de autenticación', mensaje: err.message });
    }
  }
}));

// ==================== PROXY PARA TRATAMIENTOS SERVICE ====================
app.use('/api/tratamientos', createProxyMiddleware({
  target: 'http://localhost:3002',
  changeOrigin: true,
  pathRewrite: { '^/api/tratamientos': '/tratamientos' },
  on: {
    error: (err, req, res) => {
      res.status(500).json({ error: 'Error en el servicio de tratamientos', mensaje: err.message });
    }
  }
}));

app.use('/api/medicamentos', createProxyMiddleware({
  target: 'http://localhost:3002',
  changeOrigin: true,
  pathRewrite: { '^/api/medicamentos': '/medicamentos' },
  on: {
    error: (err, req, res) => {
      res.status(500).json({ error: 'Error en el servicio de tratamientos', mensaje: err.message });
    }
  }
}));

// ==================== PROXY PARA CITAS SERVICE ====================
app.use('/api/citas', createProxyMiddleware({
  target: 'http://localhost:3003',
  changeOrigin: true,
  pathRewrite: { '^/api/citas': '/citas' },
  on: {
    error: (err, req, res) => {
      res.status(500).json({ error: 'Error en el servicio de citas', mensaje: err.message });
    }
  }
}));

// ==================== PROXY PARA ESTUDIOS SERVICE (NUEVO) ====================
app.use('/api/estudios', createProxyMiddleware({
  target: 'http://localhost:3004',
  changeOrigin: true,
  pathRewrite: { '^/api/estudios': '/estudios' },
  on: {
    error: (err, req, res) => {
      res.status(500).json({ error: 'Error en el servicio de estudios', mensaje: err.message });
    }
  }
}));

// Para desarrollo - endpoint de prueba
app.get('/api/estudios/health', (req, res) => {
  res.json({ status: 'OK', service: 'estudios-proxy' });
});

app.listen(PORT, () => {
  console.log(`✅ API Gateway running on port ${PORT}`);
});
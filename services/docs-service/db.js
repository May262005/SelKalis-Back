// db.js
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

console.log('🔌 Inicializando cliente Supabase para Documentos...');

if (!process.env.SUPABASE_URL) {
  console.error('❌ Error: SUPABASE_URL no encontrado en .env');
  process.exit(1);
}

// ✅ USAR SERVICE_ROLE_KEY (tiene permisos de administrador)
// Si no está disponible, usar ANON_KEY como fallback
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

if (!supabaseKey) {
  console.error('❌ Error: No se encontró ninguna clave de API');
  process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  supabaseKey
);

console.log('✅ Cliente Supabase para Documentos inicializado');
console.log(`🔑 Usando: ${process.env.SUPABASE_SERVICE_ROLE_KEY ? 'SERVICE_ROLE_KEY' : 'ANON_KEY'}`);

module.exports = supabase;
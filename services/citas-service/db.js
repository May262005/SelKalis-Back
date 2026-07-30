// services/auth-service/db.js
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

console.log('🔌 Inicializando cliente Supabase...');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
  console.error('❌ Error: SUPABASE_URL o SUPABASE_ANON_KEY no encontrados en .env');
  console.error('📁 Buscando .env en:', path.join(__dirname, '../../.env'));
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

console.log('✅ Cliente Supabase inicializado');

module.exports = supabase;
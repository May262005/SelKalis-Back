const { createClient } = require('@supabase/supabase-js');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

console.log('Conectando a Supabase para Wearable...');

if (!process.env.SUPABASE_URL) {
  console.error('ERROR: SUPABASE_URL no definido');
  process.exit(1);
}

const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

if (!supabaseKey) {
  console.error('ERROR: No se encontró clave de API');
  process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  supabaseKey
);

console.log('Supabase para Wearable conectado');

module.exports = supabase;
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const requiredEnvironment = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
const missingEnvironment = requiredEnvironment.filter(key => !process.env[key]);

if (missingEnvironment.length) {
  throw new Error(`Faltan variables de entorno requeridas: ${missingEnvironment.join(', ')}`);
}

module.exports = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

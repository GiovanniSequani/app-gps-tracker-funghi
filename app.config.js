const fs = require('fs');
const path = require('path');

function readDotEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return {};

  return fs
    .readFileSync(envPath, 'utf8')
    .split(/\r?\n/)
    .reduce((acc, line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return acc;
      const eq = trimmed.indexOf('=');
      if (eq === -1) return acc;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      acc[key] = value;
      return acc;
    }, {});
}

const env = { ...readDotEnv(), ...process.env };
const appJson = require('./app.json');
const defaultSupabaseUrl = 'https://ovdfsehovsrdzcoqdlfh.supabase.co';
const isValidSupabaseUrl = (value) =>
  /^https:\/\/[a-z0-9]+\.supabase\.co$/i.test(value || '') &&
  !value.includes('xxxxx') &&
  !value.includes('your-project');

module.exports = {
  ...appJson.expo,
  extra: {
    ...appJson.expo.extra,
    supabaseUrl: isValidSupabaseUrl(env.EXPO_PUBLIC_SUPABASE_URL)
      ? env.EXPO_PUBLIC_SUPABASE_URL
      : defaultSupabaseUrl,
    supabaseAnonKey: env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
  },
};

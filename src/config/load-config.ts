import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { AppConfigSchema, type AppConfig } from './schema.js';

export function loadDotEnv(file = '.env'): void {
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const [key, ...rest] = line.split('=');
    if (!process.env[key]) process.env[key] = rest.join('=').replace(/^"|"$/g, '');
  }
}

export function loadConfig(configPath = 'config/config.yaml'): AppConfig {
  const absolute = path.resolve(configPath);
  if (!fs.existsSync(absolute)) {
    throw new Error(`Config file not found: ${configPath}. Copy config/config.example.yaml to config/config.yaml first.`);
  }
  const parsed = yaml.load(fs.readFileSync(absolute, 'utf8'));
  return AppConfigSchema.parse(parsed);
}


'use strict';

const fs       = require('fs');
const path     = require('path');
const Anthropic = require('@anthropic-ai/sdk');

// BOT_BASE apunta al directorio raíz del bot principal.
// src/ está un nivel más adentro, por eso ../../ en la ruta por defecto.
const BASE               = process.env.BOT_BASE || path.join(__dirname, '..', '..', 'bot-tacos');
const DATOS              = path.join(BASE, 'datos');
const INSTRUCCIONES_PATH = path.join(DATOS, 'instrucciones.txt');
const MENU_PATH          = path.join(DATOS, 'menu.csv');
const NO_DISP_PATH       = path.join(DATOS, 'no_disponible.txt');
const LOY_CONFIG_PATH    = path.join(DATOS, 'loyverse_config.json');
const INTERV_PATH        = path.join(DATOS, 'intervenciones_humanas.json');
const LOGS_DIR           = path.join(BASE, 'logs');
const ERROR_LOG          = path.join(LOGS_DIR, 'error.log');
const OUTPUT_LOG         = path.join(LOGS_DIR, 'output.log');
const TEMP_DIR           = path.join(BASE, 'temp');

try { fs.mkdirSync(TEMP_DIR, { recursive: true }); } catch (e) {}

let ANTHROPIC_KEY = '';
try {
  ANTHROPIC_KEY = process.env.ANTHROPIC_KEY ||
    fs.readFileSync(path.join(DATOS, 'anthropic_key.txt'), 'utf8').trim();
} catch (e) {
  console.error('❌ Falta ANTHROPIC_KEY. Ponlo en env o en datos/anthropic_key.txt');
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });

// Módulos DB del bot (se resuelven con ruta absoluta para soportar cualquier __dirname)
const memDb      = require(path.resolve(DATOS, 'memoria_db'));
const mensajesDb = require(path.resolve(DATOS, 'mensajes_db'));

module.exports = {
  BASE, DATOS,
  INSTRUCCIONES_PATH, MENU_PATH, NO_DISP_PATH, LOY_CONFIG_PATH,
  INTERV_PATH, LOGS_DIR, ERROR_LOG, OUTPUT_LOG, TEMP_DIR,
  anthropic, memDb, mensajesDb,
};

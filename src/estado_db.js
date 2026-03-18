'use strict';

/**
 * estado_db.js — Persiste el estado del monitor en SQLite.
 * Reemplaza agente_estado.json y agente_pendientes.json (archivos JSON con
 * riesgo de condición de carrera en escrituras concurrentes).
 *
 * Tablas:
 *   estado_conv  – última posición analizada por teléfono
 *   pendientes   – alertas y propuestas esperando respuesta del admin
 */

const Database = require('better-sqlite3');
const path     = require('path');
const { DATOS } = require('./config');

const DB_PATH = path.join(DATOS, 'monitor.db');

let _db = null;

function getDb() {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('busy_timeout = 5000');
  _db.exec(`
    CREATE TABLE IF NOT EXISTS estado_conv (
      telefono TEXT PRIMARY KEY,
      longitud INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS pendientes (
      id        TEXT PRIMARY KEY,
      tipo      TEXT NOT NULL,
      datos     TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    );
  `);
  return _db;
}

function cargarEstadoConv() {
  const rows = getDb().prepare('SELECT telefono, longitud FROM estado_conv').all();
  const estado = {};
  for (const r of rows) estado[r.telefono] = r.longitud;
  return estado;
}

function guardarEstadoConv(estadoConv) {
  const upsert = getDb().prepare(
    'INSERT OR REPLACE INTO estado_conv (telefono, longitud) VALUES (?, ?)'
  );
  const tx = getDb().transaction((estado) => {
    for (const [tel, lon] of Object.entries(estado)) upsert.run(tel, lon);
  });
  tx(estadoConv);
}

function cargarPendientes() {
  return getDb()
    .prepare('SELECT id, tipo, datos, timestamp FROM pendientes ORDER BY timestamp ASC')
    .all()
    .map(r => ({ id: r.id, tipo: r.tipo, datos: JSON.parse(r.datos), timestamp: r.timestamp }));
}

function guardarPendientes(pendientes) {
  const db     = getDb();
  const insert = db.prepare(
    'INSERT OR REPLACE INTO pendientes (id, tipo, datos, timestamp) VALUES (?, ?, ?, ?)'
  );
  const del = db.prepare('DELETE FROM pendientes WHERE id = ?');

  // Sincronizar: insertar/actualizar los que hay, borrar los que ya no existen
  const ids = new Set(pendientes.map(p => p.id));
  const tx  = db.transaction(() => {
    // Eliminar los que ya no están en la lista
    const existentes = db.prepare('SELECT id FROM pendientes').all().map(r => r.id);
    for (const id of existentes) {
      if (!ids.has(id)) del.run(id);
    }
    // Upsert los actuales
    for (const p of pendientes) {
      insert.run(p.id, p.tipo, JSON.stringify(p.datos), p.timestamp);
    }
  });
  tx();
}

module.exports = { cargarEstadoConv, guardarEstadoConv, cargarPendientes, guardarPendientes };

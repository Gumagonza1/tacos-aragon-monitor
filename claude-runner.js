'use strict';

/**
 * claude-runner.js — Monitor Bot (Linux/Docker)
 *
 * Ejecuta claude -p via shell.
 *
 *   ejecutarRapido(fullPrompt, timeoutMs)
 *     → max-turns 1, sin MCP, salida texto plano
 *     → para análisis rápido de calidad por conversación
 *
 *   ejecutarProfundo(systemPrompt, userPrompt, timeoutMs)
 *     → max-turns 20, MCP project-tacos-bot, salida texto
 *     → para análisis profundo, propuestas de código, consultas al admin
 */

const { spawn }  = require('child_process');
const fs         = require('fs');
const path       = require('path');
const os         = require('os');
const crypto     = require('crypto');

const MCP_CONFIG = path.join(__dirname, 'mcp-monitor.json');

function log(msg) {
  const ahora = new Date().toLocaleString('es-MX', { timeZone: 'America/Hermosillo' });
  console.log(`[${ahora}] [monitor-runner] ${msg}`);
}

// ── Guard anti-reentrancia para análisis profundo ─────────────────────────────

let _ejecutandoProfundo = false;
let _pidActual          = null;

// ── Matar árbol de procesos ────────────────────────────────────────────────────

function matarArbol(pid) {
  if (!pid) return;
  try { process.kill(pid, 'SIGKILL'); } catch {}
  // Fallback: kill process group
  try { process.kill(-pid, 'SIGKILL'); } catch {}
}

process.on('exit',    () => { if (_pidActual) matarArbol(_pidActual); });
process.on('SIGTERM', () => { if (_pidActual) matarArbol(_pidActual); process.exit(0); });

// ── Spawn interno (Linux shell) ───────────────────────────────────────────────

function _spawnarShell(shellCmd, cwd, timeoutMs) {
  const INACT_MS  = 3 * 60 * 1000; // 3 min sin bytes → atascado

  return new Promise((resolve) => {
    let rawOutput  = '';
    let stderrBuf  = '';
    let finished   = false;
    let lastActAt  = Date.now();

    const proc = spawn('/bin/sh', ['-c', shellCmd], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    _pidActual = proc.pid;

    proc.stdout.on('data', (d) => { lastActAt = Date.now(); rawOutput += d.toString(); });
    proc.stderr.on('data', (d) => {
      lastActAt = Date.now();
      const chunk = d.toString().trim();
      if (chunk) stderrBuf += chunk + '\n';
    });

    const watchdog = setInterval(() => {
      if (finished) { clearInterval(watchdog); return; }
      if (Date.now() - lastActAt >= INACT_MS) {
        clearInterval(watchdog);
        clearTimeout(hardCap);
        finished = true;
        matarArbol(proc.pid);
        _pidActual = null;
        log('Inactividad — proceso cortado');
        resolve({ ok: false, output: rawOutput.trim() || stderrBuf.trim() || '(sin respuesta)' });
      }
    }, 30_000);

    const hardCap = setTimeout(() => {
      if (!finished) {
        clearInterval(watchdog);
        finished = true;
        matarArbol(proc.pid);
        _pidActual = null;
        log(`Hard cap alcanzado (${Math.round(timeoutMs / 60000)}min)`);
        resolve({ ok: false, output: rawOutput.trim() || stderrBuf.trim() || '(timeout)' });
      }
    }, timeoutMs);

    proc.on('close', (code) => {
      if (!finished) {
        finished = true;
        clearInterval(watchdog);
        clearTimeout(hardCap);
        _pidActual = null;
        const out = rawOutput.trim() || stderrBuf.trim() || '(sin respuesta)';
        resolve({ ok: code === 0 && out.length > 0, output: out });
      }
    });

    proc.on('error', (err) => {
      if (!finished) {
        finished = true;
        clearInterval(watchdog);
        clearTimeout(hardCap);
        _pidActual = null;
        resolve({ ok: false, output: `ERROR spawn: ${err.message}` });
      }
    });
  });
}

// ── Rápido — sin MCP, max-turns 1 ─────────────────────────────────────────────

async function ejecutarRapido(fullPrompt, timeoutMs = 60_000) {
  const tmpId     = crypto.randomBytes(6).toString('hex');
  const tmpPrompt = path.join(os.tmpdir(), `monitor-prompt-${tmpId}.txt`);

  fs.writeFileSync(tmpPrompt, fullPrompt, 'utf-8');

  const cmd = `cat "${tmpPrompt}" | claude -p --output-format text --model sonnet --max-turns 1 --no-session-persistence`;

  try {
    const cwd    = path.join(__dirname, '..');
    const result = await _spawnarShell(cmd, cwd, timeoutMs);
    return result.output || '(sin respuesta)';
  } finally {
    try { fs.unlinkSync(tmpPrompt); } catch {}
  }
}

// ── Profundo — MCP tacos-bot, max-turns 20 ────────────────────────────────────

async function ejecutarProfundo(systemPrompt, userPrompt, timeoutMs = 300_000) {
  if (_ejecutandoProfundo) {
    return { ok: false, output: 'ERROR: Ya hay un análisis profundo en curso — intenta en unos minutos' };
  }
  _ejecutandoProfundo = true;

  const tmpId     = crypto.randomBytes(6).toString('hex');
  const tmpPrompt = path.join(os.tmpdir(), `monitor-deep-${tmpId}.txt`);

  const fullPrompt = `=== INSTRUCCIONES ===\n${systemPrompt}\n\n=== TAREA ===\n${userPrompt}`;
  fs.writeFileSync(tmpPrompt, fullPrompt, 'utf-8');

  const cmd = `cat "${tmpPrompt}" | claude -p` +
    ` --output-format text` +
    ` --model sonnet` +
    ` --mcp-config "${MCP_CONFIG}"` +
    ` --strict-mcp-config` +
    ` --permission-mode bypassPermissions` +
    ` --max-turns 20` +
    ` --no-session-persistence` +
    ` --max-budget-usd 1.00`;

  try {
    const cwd = path.join(__dirname, '..');
    return await _spawnarShell(cmd, cwd, timeoutMs);
  } finally {
    _ejecutandoProfundo = false;
    try { fs.unlinkSync(tmpPrompt); } catch {}
  }
}

module.exports = { ejecutarRapido, ejecutarProfundo };

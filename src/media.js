'use strict';

const fs   = require('fs');
const http  = require('http');
const https = require('https');
const path  = require('path');
const { TEMP_DIR } = require('./config');

/** Descarga cualquier URL HTTPS/HTTP a un archivo local, siguiendo redirects */
function descargarArchivo(url, destino) {
  return new Promise((resolve, reject) => {
    const doGet = (targetUrl, saltos = 0) => {
      if (saltos > 5) { reject(new Error('Demasiados redirects')); return; }
      const lib = targetUrl.startsWith('https') ? https : http;
      lib.get(targetUrl, { headers: { 'User-Agent': 'Mozilla/5.0 TacosBot/1.0' } }, res => {
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
          doGet(res.headers.location, saltos + 1);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} al descargar ${targetUrl}`));
          return;
        }
        const file = fs.createWriteStream(destino);
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(destino); });
        file.on('error', reject);
      }).on('error', reject);
    };
    doGet(url);
  });
}

/**
 * Genera una gráfica PNG usando quickchart.io y la guarda en TEMP_DIR.
 * @param {object} opts - { titulo, labels, valores, tipo, labelDataset }
 * @returns {Promise<string>} ruta del PNG generado
 */
async function generarGrafica({ titulo, labels, valores, tipo = 'bar', labelDataset = 'Ventas $' }) {
  const COLORES = ['#E07B39','#D4623A','#C94E2B','#BE3A1C','#B3260D','#FF9966','#FFCC99','#FF6633'];
  const esLinea = tipo === 'line';
  const config  = {
    type: tipo,
    data: {
      labels,
      datasets: [{
        label:           labelDataset,
        data:            valores,
        backgroundColor: esLinea ? 'rgba(224,123,57,0.2)' : labels.map((_, i) => COLORES[i % COLORES.length]),
        borderColor:     '#E07B39',
        borderWidth:     2,
        fill:            esLinea,
        tension:         0.3,
        pointRadius:     4,
      }],
    },
    options: {
      title:  { display: true, text: titulo, fontSize: 16, fontColor: '#333' },
      legend: { display: true },
      scales: {
        yAxes: [{ ticks: { beginAtZero: true } }],
        xAxes: [{ ticks: { maxRotation: 45 } }],
      },
    },
  };
  const chartUrl = `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(config))}&w=700&h=420&bkg=white&f=png`;
  const destino  = path.join(TEMP_DIR, `grafica_${Date.now()}.png`);
  await descargarArchivo(chartUrl, destino);
  return destino;
}

/**
 * Genera un audio MP3 con Google TTS (español) y lo guarda en TEMP_DIR.
 * Máx 200 caracteres para evitar error en la API.
 */
async function generarVoz(texto) {
  const textoCortado = texto.slice(0, 200);
  const encoded = encodeURIComponent(textoCortado);
  const url     = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encoded}&tl=es&client=tw-ob&ttsspeed=0.85`;
  const destino = path.join(TEMP_DIR, `voz_${Date.now()}.mp3`);
  await descargarArchivo(url, destino);
  return destino;
}

module.exports = { generarGrafica, generarVoz };

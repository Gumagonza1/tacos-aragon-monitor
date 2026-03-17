// PM2 ECOSYSTEM CONFIG — Tacos Aragón Monitor
// Uso: pm2 start ecosystem.config.js
//
// Configura BOT_BASE para apuntar al directorio raíz del bot principal.
// ANTHROPIC_KEY puede ir aquí o en datos/anthropic_key.txt del bot principal.

module.exports = {
    apps: [
        {
            name: 'MonitorBot',
            script: 'agente_monitor.js',

            watch: false,
            max_restarts: 10,
            restart_delay: 8000,

            error_file: './logs/monitor-error.log',
            out_file:   './logs/monitor-output.log',
            merge_logs: true,
            log_date_format: 'YYYY-MM-DD HH:mm:ss',

            env: {
                NODE_ENV: 'production',

                // Ruta absoluta al directorio raíz del bot principal
                // (donde están datos/ y logs/)
                BOT_BASE: 'C:/Users/tu_usuario/Desktop/bot-tacos',

                // API Key de Anthropic (claude-sonnet-4-6)
                // Alternativa: dejar en blanco y crear datos/anthropic_key.txt en el bot principal
                ANTHROPIC_KEY: '',

                // URL y token de la API central del bot (para la herramienta consultar_api)
                TACOS_API_URL:   'http://localhost:3001',
                TACOS_API_TOKEN: '',
            }
        }
    ]
};

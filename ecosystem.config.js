// FinanceHub — Configuração PM2
// pm2 start ecosystem.config.js
// pm2 save && pm2 startup

module.exports = {
  apps: [
    {
      name:         'financehub',
      script:       './server/index.js',
      instances:    1,           // aumente para 'max' em servidores com múltiplos CPUs
      exec_mode:    'fork',
      watch:        false,
      max_memory_restart: '300M',

      env_production: {
        NODE_ENV:  'production',
        PORT:      3000,
      },

      // Logs
      out_file:   './logs/out.log',
      error_file: './logs/error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,

      // Reinicio automático em crash
      autorestart:   true,
      restart_delay: 3000,
      max_restarts:  10,

      // Graceful shutdown
      kill_timeout:  5000,
      wait_ready:    true,
      listen_timeout: 8000,
    }
  ]
};

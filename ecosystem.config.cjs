/** PM2 — Oracle Always Free / any VPS */
module.exports = {
  apps: [
    {
      name: 'xerago-iot',
      script: 'server/index.js',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        PORT: 3847,
      },
      max_memory_restart: '400M',
      watch: false,
      time: true,
    },
  ],
};

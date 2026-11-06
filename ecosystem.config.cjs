// PM2 config for the EC2 server: pm2 start ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: 'website-api',
      script: 'server.js',
      cwd: __dirname,
      env: { NODE_ENV: 'production' }
    }
  ]
};

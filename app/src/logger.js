// Log JSON một dòng ra stdout/stderr để Promtail/Loki parse được bằng `| json`
function log(level, msg, extra = {}) {
  const line = JSON.stringify({ time: new Date().toISOString(), level, msg, ...extra });
  if (level === 'error') console.error(line);
  else console.log(line);
}

module.exports = {
  info: (msg, extra) => log('info', msg, extra),
  warn: (msg, extra) => log('warn', msg, extra),
  error: (msg, extra) => log('error', msg, extra),
};

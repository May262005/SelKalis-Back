function obtenerFechaHoraLocal(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`;
}

function citaYaPaso(fecha, hora, timezone, now = new Date()) {
  return `${fecha}T${String(hora).slice(0, 5)}` < obtenerFechaHoraLocal(now, timezone);
}

module.exports = { citaYaPaso };

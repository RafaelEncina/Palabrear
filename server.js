'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { Sala, FASES, normalizar } = require('./juego');

const PUERTO = process.env.PORT || 3000;
const SEGUNDOS_RESUMEN = 10; // pausa entre turnos para ver la palabra y el puntaje
const MINUTOS_SALA_VACIA = 15; // despues de esto, la sala vacia se borra

const app = express();
const servidor = http.createServer(app);
const io = new Server(servidor);

// URL publica oficial (ej. https://palabrear.com). Si esta definida, se usa como
// direccion canonica y las visitas a otros dominios (ej. *.onrender.com) se redirigen.
const URL_PUBLICA = (process.env.URL_PUBLICA || '').replace(/\/+$/, '');
const HOST_PUBLICO = URL_PUBLICA ? new URL(URL_PUBLICA).host : null;

const origenDe = (req) => `${req.get('x-forwarded-proto') || req.protocol}://${req.get('host')}`;
const canonicaDe = (req) => URL_PUBLICA || origenDe(req);

app.use((req, res, next) => {
  const host = req.get('host') || '';
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
  const omitir = req.path.startsWith('/socket.io') || req.path === '/salud';
  if (HOST_PUBLICO && host !== HOST_PUBLICO && !local && !omitir && req.method === 'GET') {
    return res.redirect(301, URL_PUBLICA + req.originalUrl);
  }
  next();
});

// La portada se sirve con URLs absolutas (og:image, canonical), porque buscadores
// y apps como WhatsApp o Discord no aceptan rutas relativas.
const fs = require('fs');
const PORTADA = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
app.get(['/', '/index.html'], (req, res) => {
  res
    .type('html')
    .send(PORTADA.replaceAll('__ORIGEN__', canonicaDe(req)).replaceAll('__CANONICA__', canonicaDe(req)));
});
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /salud\n\nSitemap: ${canonicaDe(req)}/sitemap.xml\n`);
});
app.get('/sitemap.xml', (req, res) => {
  res.type('application/xml').send(
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      `  <url><loc>${canonicaDe(req)}/</loc><changefreq>monthly</changefreq><priority>1.0</priority></url>\n` +
      '</urlset>\n'
  );
});
app.use(express.static(path.join(__dirname, 'public'), { index: false }));
app.get('/salud', (_req, res) => res.json({ ok: true, salas: salas.size }));

/** @type {Map<string, Sala>} */
const salas = new Map();
/** socket.id -> { codigo, jugadorId } */
const sesiones = new Map();

function codigoUnico() {
  let codigo;
  do {
    codigo = new Sala({}).codigo;
  } while (salas.has(codigo));
  return codigo;
}

function salasPublicas() {
  return [...salas.values()]
    .filter((s) => s.visibilidad === 'publica' && s.activos.length > 0)
    .sort((a, b) => b.ultimaActividad - a.ultimaActividad)
    .slice(0, 30)
    .map((s) => s.resumenPublico());
}

/** Manda a cada socket de la sala su propia vista del estado. */
function emitirEstado(sala) {
  for (const [socketId, sesion] of sesiones) {
    if (sesion.codigo !== sala.codigo) continue;
    const socket = io.sockets.sockets.get(socketId);
    if (!socket) continue;
    const estado = sala.estadoPara(sesion.jugadorId);
    estado.resumenHasta = sala._resumenHasta || null;
    socket.emit('estado', estado);
  }
}

function anunciar(sala, texto) {
  io.to(sala.codigo).emit('aviso', texto);
}

function salaDe(socket) {
  const sesion = sesiones.get(socket.id);
  if (!sesion) return null;
  return salas.get(sesion.codigo) || null;
}

function jugadorIdDe(socket) {
  const sesion = sesiones.get(socket.id);
  return sesion ? sesion.jugadorId : null;
}

function sacarDeSala(socket) {
  const sesion = sesiones.get(socket.id);
  if (!sesion) return;
  const sala = salas.get(sesion.codigo);
  sesiones.delete(socket.id);
  socket.leave(sesion.codigo);
  if (!sala) return;

  // Solo lo marcamos desconectado si no le quedan otras pestanias abiertas.
  const sigueConectado = [...sesiones.values()].some(
    (s) => s.codigo === sala.codigo && s.jugadorId === sesion.jugadorId
  );
  if (!sigueConectado) {
    const jugador = sala.jugador(sesion.jugadorId);
    sala.desconectar(sesion.jugadorId);
    if (jugador) anunciar(sala, `${jugador.nombre} se fue de la sala.`);
    revisarTurno(sala);
  }
  emitirEstado(sala);
}

/**
 * Cierra el turno cuando ya no queda nadie por adivinar, cuando se agota
 * el tiempo, o cuando el escritor se desconecto sin escribir.
 */
function revisarTurno(sala) {
  if (sala.fase === FASES.ESCRIBIENDO) {
    const escritor = sala.jugador(sala.escritorId);
    const sinEscritor = !escritor || !escritor.conectado;
    if (sinEscritor || sala.tiempoAgotado) {
      sala.cerrarTurno('abandono');
      programarResumen(sala);
    }
    return;
  }
  if (sala.fase === FASES.ADIVINANDO) {
    if (sala.turnoCompleto) {
      sala.cerrarTurno('listo');
      programarResumen(sala);
    } else if (sala.tiempoAgotado) {
      sala.cerrarTurno('tiempo');
      programarResumen(sala);
    }
  }
}

function programarResumen(sala) {
  sala._resumenHasta = Date.now() + SEGUNDOS_RESUMEN * 1000;
}

function avanzarSala(sala) {
  sala._resumenHasta = null;
  const r = sala.avanzar();
  if (r.ok && !r.fin && sala.config.segundosPorTurno > 0) {
    // El reloj de la fase de escritura usa el mismo limite del turno.
    sala.turno.venceEn = Date.now() + sala.config.segundosPorTurno * 1000;
  }
  emitirEstado(sala);
}

// Un solo reloj para todas las salas: cierra turnos y limpia salas vacias.
setInterval(() => {
  const ahora = Date.now();
  for (const sala of [...salas.values()]) {
    const faseAntes = sala.fase;
    revisarTurno(sala);

    if (sala.fase === FASES.RESUMEN && sala._resumenHasta && ahora >= sala._resumenHasta) {
      avanzarSala(sala);
    } else if (sala.fase !== faseAntes) {
      emitirEstado(sala);
    } else if (sala.fase === FASES.ESCRIBIENDO || sala.fase === FASES.ADIVINANDO) {
      // Mantiene los relojes de los clientes sincronizados sin spamear.
      if (Math.floor(ahora / 1000) % 5 === 0) emitirEstado(sala);
    }

    const vacia = sala.activos.length === 0;
    if (vacia && ahora - sala.ultimaActividad > MINUTOS_SALA_VACIA * 60 * 1000) {
      salas.delete(sala.codigo);
    }
  }
}, 1000);

io.on('connection', (socket) => {
  const jugadorId = String((socket.handshake.auth && socket.handshake.auth.jugadorId) || '').slice(0, 64);
  if (!jugadorId) {
    socket.emit('aviso', 'No se pudo identificar tu sesion. Recarga la pagina.');
    return socket.disconnect(true);
  }

  socket.on('salas', (cb) => typeof cb === 'function' && cb(salasPublicas()));

  socket.on('crear', (datos = {}, cb) => {
    sacarDeSala(socket);
    const sala = new Sala({
      codigo: codigoUnico(),
      nombre: datos.nombreSala,
      visibilidad: datos.visibilidad,
      config: datos.config,
    });
    salas.set(sala.codigo, sala);
    const alta = sala.agregarJugador({ id: jugadorId, nombre: datos.nombre });
    if (!alta.ok) {
      salas.delete(sala.codigo);
      return typeof cb === 'function' && cb({ ok: false, error: alta.error });
    }
    sesiones.set(socket.id, { codigo: sala.codigo, jugadorId });
    socket.join(sala.codigo);
    emitirEstado(sala);
    if (typeof cb === 'function') cb({ ok: true, codigo: sala.codigo });
  });

  socket.on('unirse', (datos = {}, cb) => {
    const codigo = normalizar(datos.codigo).replace(/[^A-Z0-9]/g, '');
    const sala = salas.get(codigo);
    if (!sala) return typeof cb === 'function' && cb({ ok: false, error: 'No existe una sala con ese codigo.' });

    sacarDeSala(socket); // deja cualquier sala anterior (o la misma, si esta recargando)
    const alta = sala.agregarJugador({ id: jugadorId, nombre: datos.nombre });
    if (!alta.ok) return typeof cb === 'function' && cb({ ok: false, error: alta.error });

    sesiones.set(socket.id, { codigo: sala.codigo, jugadorId });
    socket.join(sala.codigo);
    anunciar(sala, alta.reconexion ? `${alta.jugador.nombre} volvio.` : `${alta.jugador.nombre} entro a la sala.`);
    emitirEstado(sala);
    if (typeof cb === 'function') cb({ ok: true, codigo: sala.codigo });
  });

  socket.on('salir', () => sacarDeSala(socket));

  socket.on('config', (datos = {}, cb) => {
    const sala = salaDe(socket);
    if (!sala) return;
    const r = sala.cambiarConfig(jugadorIdDe(socket), datos);
    emitirEstado(sala);
    if (typeof cb === 'function') cb(r);
  });

  socket.on('iniciar', (_datos, cb) => {
    const sala = salaDe(socket);
    if (!sala) return;
    const r = sala.iniciar(jugadorIdDe(socket));
    if (r.ok && sala.config.segundosPorTurno > 0) {
      sala.turno.venceEn = Date.now() + sala.config.segundosPorTurno * 1000;
    }
    emitirEstado(sala);
    if (typeof cb === 'function') cb(r);
  });

  socket.on('palabra', (datos = {}, cb) => {
    const sala = salaDe(socket);
    if (!sala) return;
    const r = sala.definirPalabra(jugadorIdDe(socket), datos.palabra, datos.pista);
    emitirEstado(sala);
    if (typeof cb === 'function') cb(r);
  });

  socket.on('adivinar', (datos = {}, cb) => {
    const sala = salaDe(socket);
    if (!sala) return;
    const r = sala.adivinar(jugadorIdDe(socket), datos.intento);
    revisarTurno(sala);
    emitirEstado(sala);
    if (typeof cb === 'function') cb(r);
  });

  socket.on('rendirse', (_datos, cb) => {
    const sala = salaDe(socket);
    if (!sala) return;
    const r = sala.rendirse(jugadorIdDe(socket));
    revisarTurno(sala);
    emitirEstado(sala);
    if (typeof cb === 'function') cb(r);
  });

  socket.on('siguiente', (_datos, cb) => {
    const sala = salaDe(socket);
    if (!sala) return;
    const yo = jugadorIdDe(socket);
    if (sala.fase === FASES.ADIVINANDO && (yo === sala.hostId || sala.esEscritor(yo))) {
      sala.cerrarTurno('corte');
      programarResumen(sala);
      emitirEstado(sala);
      return typeof cb === 'function' && cb({ ok: true });
    }
    if (sala.fase !== FASES.RESUMEN) {
      return typeof cb === 'function' && cb({ ok: false, error: 'El turno sigue en juego.' });
    }
    if (yo !== sala.hostId) {
      return typeof cb === 'function' && cb({ ok: false, error: 'Solo el anfitrion puede adelantar.' });
    }
    avanzarSala(sala);
    if (typeof cb === 'function') cb({ ok: true });
  });

  socket.on('revancha', (_datos, cb) => {
    const sala = salaDe(socket);
    if (!sala) return;
    const r = sala.reiniciar(jugadorIdDe(socket));
    sala._resumenHasta = null;
    emitirEstado(sala);
    if (typeof cb === 'function') cb(r);
  });

  socket.on('chat', (datos = {}) => {
    const sala = salaDe(socket);
    if (!sala) return;
    const jugador = sala.jugador(jugadorIdDe(socket));
    if (!jugador) return;
    const texto = String(datos.texto || '').trim().slice(0, 200);
    if (!texto) return;

    // Antispoiler: si el mensaje contiene la palabra en juego, no se publica.
    if (sala.fase === FASES.ADIVINANDO && sala.turno.palabra) {
      if (normalizar(texto).includes(sala.turno.palabra)) {
        return socket.emit('aviso', 'Ese mensaje revelaba la palabra, no lo mande.');
      }
    }
    io.to(sala.codigo).emit('chat', { nombre: jugador.nombre, texto, en: Date.now() });
  });

  socket.on('disconnect', () => sacarDeSala(socket));
});

servidor.listen(PUERTO, () => {
  console.log(`\n  Palabrear andando en http://localhost:${PUERTO}\n`);
});

module.exports = { app, servidor, io, salas };

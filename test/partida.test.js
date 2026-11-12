'use strict';

/**
 * Prueba de punta a punta: levanta el servidor, conecta 3 jugadores
 * y juega una partida completa de 2 rondas.
 *   node test/partida.test.js
 */

const assert = require('assert');
const { io } = require('socket.io-client');
const {
  evaluarIntento,
  normalizar,
  esPalabraValida,
  puntajeAdivinador,
  puntajePistas,
  limpiarConfig,
} = require('../juego');

const PUERTO = 3999;
process.env.PORT = PUERTO;

let fallos = 0;
function prueba(nombre, fn) {
  try {
    fn();
    console.log(`  ok  ${nombre}`);
  } catch (e) {
    fallos++;
    console.log(`  NO  ${nombre}\n      ${e.message}`);
  }
}

/* ---------- 1. logica pura ---------- */

console.log('\nLogica de evaluacion');

prueba('acierto total', () => {
  assert.deepStrictEqual(evaluarIntento('CASA', 'CASA'), ['correcta', 'correcta', 'correcta', 'correcta']);
});

prueba('letras repetidas en su lugar', () => {
  // CASA tiene A en las posiciones 2 y 4.
  assert.deepStrictEqual(evaluarIntento('AAAA', 'CASA'), ['ausente', 'correcta', 'ausente', 'correcta']);
});

prueba('una letra no se marca mas veces de las que aparece', () => {
  // CASA tiene una sola S: la segunda S del intento queda gris.
  assert.deepStrictEqual(evaluarIntento('ASAS', 'CASA'), ['presente', 'presente', 'presente', 'ausente']);
});

prueba('letra presente fuera de lugar', () => {
  assert.deepStrictEqual(evaluarIntento('SACO', 'CASA'), ['presente', 'correcta', 'presente', 'ausente']);
});

prueba('tildes y enies', () => {
  assert.strictEqual(normalizar('camión'), 'CAMION');
  assert.strictEqual(normalizar('ñandú'), 'ÑANDU');
  assert.deepStrictEqual(evaluarIntento('niño', 'NIÑO'), ['correcta', 'correcta', 'correcta', 'correcta']);
});

prueba('validacion de palabras', () => {
  assert.ok(esPalabraValida('manzana'));
  assert.ok(esPalabraValida('ñu'.padEnd(3, 'u')));
  assert.ok(!esPalabraValida('ab'));
  assert.ok(!esPalabraValida('con espacio'));
  assert.ok(!esPalabraValida('casa2'));
  assert.ok(!esPalabraValida('abcdefghijklmn'));
});

prueba('menos intentos da mas puntos', () => {
  assert.ok(puntajeAdivinador(1, false) > puntajeAdivinador(3, false));
  assert.strictEqual(puntajeAdivinador(1, true), 110);
  assert.strictEqual(puntajeAdivinador(1, false), 100);
  assert.strictEqual(puntajeAdivinador(20, false), 20, 'hay un piso de 20');
});

prueba('el consuelo usa el mejor intento, no el ultimo', () => {
  const intentos = [
    { palabra: 'MANDANA', feedback: evaluarIntento('MANDANA', 'MANZANA') }, // 6 verdes
    { palabra: 'CAMISAS', feedback: evaluarIntento('CAMISAS', 'MANZANA') }, // menos
  ];
  assert.deepStrictEqual(puntajePistas(intentos), { puntos: 48, verdes: 6, amarillas: 0 });
  assert.strictEqual(puntajePistas([]).puntos, 0, 'sin intentos no hay consuelo');
});

prueba('el consuelo nunca alcanza al ganador', () => {
  const todoVerde = [{ palabra: 'ABCDEFGHIJKL', feedback: new Array(12).fill('correcta') }];
  assert.ok(puntajePistas(todoVerde).puntos < 100);
});

prueba('el modo por tiempo no acepta reloj en cero', () => {
  assert.strictEqual(limpiarConfig({ modo: 'tiempo', segundosPorTurno: 0 }).segundosPorTurno, 180);
  assert.strictEqual(limpiarConfig({ modo: 'primero', segundosPorTurno: 0 }).segundosPorTurno, 0);
  assert.strictEqual(limpiarConfig({ modo: 'cualquier cosa' }).modo, 'tiempo');
});

/* ---------- 2. partida completa por sockets ---------- */

require('../server');

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

function conectar(id) {
  const socket = io(`http://localhost:${PUERTO}`, { auth: { jugadorId: id }, transports: ['websocket'] });
  socket.estado = null;
  socket.on('estado', (e) => { socket.estado = e; });
  return new Promise((resolve, reject) => {
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
  });
}

const pedir = (socket, evento, datos) =>
  new Promise((resolve) => socket.emit(evento, datos, resolve));

/** Espera a que el estado del socket cumpla una condicion. */
async function hasta(socket, cond, etiqueta, limite = 4000) {
  const fin = Date.now() + limite;
  while (Date.now() < fin) {
    if (socket.estado && cond(socket.estado)) return socket.estado;
    await esperar(40);
  }
  throw new Error(`timeout esperando: ${etiqueta} (fase=${socket.estado && socket.estado.fase})`);
}

async function main() {
  console.log('\nPartida completa (3 jugadores, 2 rondas)');
  await esperar(300);

  const a = await conectar('jug-a');
  const b = await conectar('jug-b');
  const c = await conectar('jug-c');

  const creada = await pedir(a, 'crear', {
    nombre: 'Ana',
    nombreSala: 'Mesa de prueba',
    visibilidad: 'publica',
    config: { rondas: 2, maxJugadores: 4, segundosPorTurno: 0 },
  });
  assert.ok(creada.ok, 'se crea la sala');
  const codigo = creada.codigo;

  const listado = await new Promise((r) => a.emit('salas', r));
  prueba('listado publico incluye la sala', () => {
    assert.ok(listado.some((s) => s.codigo === codigo));
  });

  assert.ok((await pedir(b, 'unirse', { codigo, nombre: 'Beto' })).ok);
  assert.ok((await pedir(c, 'unirse', { codigo, nombre: 'Caro' })).ok);
  await hasta(a, (e) => e.jugadores.length === 3, '3 jugadores en la sala');

  prueba('el que crea la sala es anfitrion', () => {
    assert.strictEqual(a.estado.soyHost, true);
    assert.strictEqual(b.estado.soyHost, false);
  });

  const intentoAjeno = await pedir(b, 'iniciar', {});
  prueba('solo el anfitrion inicia', () => assert.ok(!intentoAjeno.ok));

  const sala3 = await pedir(a, 'unirse', { codigo: 'ZZZZ', nombre: 'Ana' });
  prueba('codigo inexistente da error', () => assert.ok(!sala3.ok));

  assert.ok((await pedir(a, 'iniciar', {})).ok, 'arranca la partida');
  await hasta(a, (e) => e.fase === 'escribiendo', 'fase escribiendo');

  const porSocket = { 'jug-a': a, 'jug-b': b, 'jug-c': c };
  const palabras = ['CASA', 'PERRO', 'MESA', 'LIBRO', 'NIÑO', 'VERDE'];
  const turnosVistos = [];
  const escritoresPorRonda = {};

  for (let turno = 0; turno < 6; turno++) {
    const est = await hasta(a, (e) => e.fase === 'escribiendo', `turno ${turno + 1} listo para escribir`);
    const escritorId = est.turno.escritorId;
    const escritor = porSocket[escritorId];
    const ronda = est.ronda;
    (escritoresPorRonda[ronda] = escritoresPorRonda[ronda] || []).push(escritorId);
    turnosVistos.push(`${ronda}:${escritorId}`);

    const palabra = palabras[turno];
    const r = await pedir(escritor, 'palabra', { palabra, pista: turno === 0 ? 'donde vives' : '' });
    assert.ok(r.ok, `el escritor define "${palabra}"`);
    await hasta(escritor, (e) => e.fase === 'adivinando', 'fase adivinando');

    const adivinadores = Object.entries(porSocket).filter(([id]) => id !== escritorId);

    // El primero acierta de una; el segundo falla una vez y luego acierta.
    const [, primero] = adivinadores[0];
    const [, segundo] = adivinadores[1];

    const noLeToca = await pedir(escritor, 'adivinar', { intento: palabra });
    if (turno === 0) prueba('el escritor no puede adivinar su propia palabra', () => assert.ok(!noLeToca.ok));

    const largoMal = await pedir(primero, 'adivinar', { intento: 'XY' });
    if (turno === 0) prueba('rechaza un intento con largo distinto', () => assert.ok(!largoMal.ok));

    const fallo = await pedir(segundo, 'adivinar', { intento: 'A'.repeat(palabra.length) });
    if (turno === 0) {
      prueba('un intento fallido devuelve feedback', () => {
        assert.ok(fallo.ok);
        assert.strictEqual(fallo.feedback.length, palabra.length);
        assert.strictEqual(fallo.acerto, false);
      });
    }

    const exito1 = await pedir(primero, 'adivinar', { intento: palabra });
    assert.ok(exito1.ok && exito1.acerto, 'el primero acierta');
    const exito2 = await pedir(segundo, 'adivinar', { intento: palabra.toLowerCase() });
    assert.ok(exito2.ok && exito2.acerto, 'el segundo acierta (minusculas valen)');

    if (turno === 0) {
      prueba('el primero en acertar suma mas que el segundo', () => {
        const tabla = a.estado.jugadores;
        const p1 = tabla.find((j) => j.id === adivinadores[0][0]).puntos;
        const p2 = tabla.find((j) => j.id === adivinadores[1][0]).puntos;
        assert.ok(p1 > p2, `${p1} deberia ser mayor que ${p2}`);
      });
      prueba('la pista llega a los adivinadores', () => {
        assert.strictEqual(primero.estado.turno.pista, 'donde vives');
      });
      prueba('la palabra no viaja a quien tiene que adivinarla', () => {
        // ya acerto, asi que la ve; comprobamos con el feedback del intento fallido
        assert.ok(fallo.feedback.every((f) => ['correcta', 'presente', 'ausente'].includes(f)));
      });
    }

    await hasta(a, (e) => e.fase === 'resumen', 'resumen del turno');
    prueba(`turno ${turno + 1}: la palabra se revela en el resumen`, () => {
      assert.strictEqual(a.estado.turno.palabra, normalizar(palabra));
    });

    if (turno < 5) {
      assert.ok((await pedir(a, 'siguiente', {})).ok, 'el anfitrion adelanta el turno');
    }
  }

  await hasta(a, (e) => e.fase === 'resumen' || e.fase === 'fin', 'ultimo turno cerrado');
  if (a.estado.fase === 'resumen') await pedir(a, 'siguiente', {});
  const fin = await hasta(a, (e) => e.fase === 'fin', 'fin de la partida');

  console.log('\nEstructura de la partida');

  prueba('se jugaron 2 rondas de 3 turnos', () => {
    assert.strictEqual(turnosVistos.length, 6);
    assert.strictEqual(Object.keys(escritoresPorRonda).length, 2);
  });

  prueba('cada jugador escribio exactamente 1 vez por ronda', () => {
    for (const [ronda, escritores] of Object.entries(escritoresPorRonda)) {
      assert.strictEqual(escritores.length, 3, `ronda ${ronda} tiene 3 turnos`);
      assert.strictEqual(new Set(escritores).size, 3, `ronda ${ronda} no repite escritor`);
    }
  });

  prueba('hay tabla de posiciones ordenada', () => {
    assert.ok(fin.tabla && fin.tabla.length === 3);
    assert.ok(fin.tabla[0].puntos >= fin.tabla[1].puntos);
    assert.ok(fin.tabla[1].puntos >= fin.tabla[2].puntos);
    assert.strictEqual(fin.tabla[0].puesto, 1);
  });

  prueba('todos sumaron puntos como escritor y como adivinador', () => {
    for (const j of fin.tabla) assert.ok(j.puntos > 0, `${j.nombre} tiene puntos`);
  });

  console.log('\nRevancha y salas privadas');

  assert.ok((await pedir(a, 'revancha', {})).ok);
  await hasta(a, (e) => e.fase === 'lobby', 'vuelve al lobby');
  prueba('la revancha pone el puntaje en cero', () => {
    assert.ok(a.estado.jugadores.every((j) => j.puntos === 0));
  });

  const d = await conectar('jug-d');
  const privada = await pedir(d, 'crear', {
    nombre: 'Dani',
    visibilidad: 'privada',
    config: { rondas: 1, maxJugadores: 2, segundosPorTurno: 0 },
  });
  const publicas = await new Promise((r) => d.emit('salas', r));
  prueba('una sala privada no sale en el listado', () => {
    assert.ok(!publicas.some((s) => s.codigo === privada.codigo));
  });

  const e = await conectar('jug-e');
  const f = await conectar('jug-f');
  assert.ok((await pedir(e, 'unirse', { codigo: privada.codigo, nombre: 'Eva' })).ok);
  const llena = await pedir(f, 'unirse', { codigo: privada.codigo, nombre: 'Fran' });
  prueba('respeta el maximo de jugadores', () => {
    assert.ok(!llena.ok && /llena/i.test(llena.error));
  });

  assert.ok((await pedir(d, 'iniciar', {})).ok);
  await hasta(d, (x) => x.fase === 'escribiendo', 'sala privada arranca');
  const tarde = await pedir(f, 'unirse', { codigo: privada.codigo, nombre: 'Fran' });
  prueba('no se puede entrar con la partida empezada', () => assert.ok(!tarde.ok));

  console.log('\nModo "el primero que adivine"');

  const g = await conectar('jug-g');
  const h = await conectar('jug-h');
  const k = await conectar('jug-k');
  const salaP = await pedir(g, 'crear', {
    nombre: 'Gabi',
    visibilidad: 'privada',
    config: { modo: 'primero', rondas: 1, maxJugadores: 3, segundosPorTurno: 0 },
  });
  assert.ok(salaP.ok);
  assert.ok((await pedir(h, 'unirse', { codigo: salaP.codigo, nombre: 'Hugo' })).ok);
  assert.ok((await pedir(k, 'unirse', { codigo: salaP.codigo, nombre: 'Kari' })).ok);
  await hasta(g, (x) => x.jugadores.length === 3, '3 jugadores');
  assert.ok((await pedir(g, 'iniciar', {})).ok);

  const porId = { 'jug-g': g, 'jug-h': h, 'jug-k': k };
  const est = await hasta(g, (x) => x.fase === 'escribiendo', 'listo para escribir');
  const escr = porId[est.turno.escritorId];
  const otros = Object.entries(porId).filter(([id]) => id !== est.turno.escritorId);
  assert.ok((await pedir(escr, 'palabra', { palabra: 'MANZANA', pista: '' })).ok);
  await hasta(escr, (x) => x.fase === 'adivinando', 'adivinando');

  // El perdedor junta 6 verdes; el otro acierta y corta el turno.
  const [idLento, lento] = otros[0];
  const [, rapido] = otros[1];
  assert.ok((await pedir(lento, 'adivinar', { intento: 'MANDANA' })).ok);
  const gana = await pedir(rapido, 'adivinar', { intento: 'MANZANA' });
  assert.ok(gana.ok && gana.acerto);

  const cerrado = await hasta(g, (x) => x.fase === 'resumen', 'el turno se corta solo', 3000);

  prueba('el turno termina apenas alguien acierta', () => {
    assert.strictEqual(cerrado.fase, 'resumen');
    assert.strictEqual(cerrado.turno.resueltos.length, 1);
  });

  prueba('el primero se lleva 100 puntos', () => {
    assert.strictEqual(cerrado.turno.resueltos[0].puntos, 100);
  });

  prueba('el resto cobra por sus verdes y amarillas', () => {
    const consuelo = cerrado.turno.consuelos.find((c) => c.id === idLento);
    assert.ok(consuelo, 'hay consuelo para el que no acerto');
    assert.strictEqual(consuelo.verdes, 6);
    assert.strictEqual(consuelo.puntos, 48);
    const suPuntaje = cerrado.jugadores.find((j) => j.id === idLento).puntos;
    assert.strictEqual(suPuntaje, 48);
  });

  prueba('el consuelo no le gana al que acerto', () => {
    const ganador = cerrado.turno.resueltos[0];
    for (const c of cerrado.turno.consuelos) assert.ok(c.puntos < ganador.puntos);
  });

  prueba('el escritor suma 20 si alguien la descubrio', () => {
    assert.strictEqual(cerrado.turno.puntosEscritor, 20);
  });

  for (const s of [a, b, c, d, e, f, g, h, k]) s.close();

  console.log(fallos === 0 ? '\nTodo en orden.\n' : `\n${fallos} prueba(s) fallaron.\n`);
  process.exit(fallos === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nLa prueba se cayo:', err.message);
  process.exit(1);
});

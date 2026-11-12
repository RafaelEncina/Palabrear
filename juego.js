'use strict';

/**
 * Logica pura de Palabrear.
 * No conoce sockets ni timers: el servidor maneja el transporte y el reloj,
 * aca vive solo el estado de la sala y sus transiciones.
 */

const LARGO_MIN = 3;
const LARGO_MAX = 12;
const MAX_INTENTOS = 30; // tope de seguridad, no un limite de juego
const CODIGO_ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin I,O,0,1

const FASES = {
  LOBBY: 'lobby',
  ESCRIBIENDO: 'escribiendo',
  ADIVINANDO: 'adivinando',
  RESUMEN: 'resumen',
  FIN: 'fin',
};

/** Quita tildes y pasa a mayusculas, conservando la enie. */
function normalizar(texto) {
  return String(texto || '')
    .trim()
    .toUpperCase()
    .replace(/Ü/g, 'U')
    .normalize('NFD')
    .replace(/(?!̃)[̀-ͯ]/g, '') // conserva el tilde de la N
    .normalize('NFC');
}

function esPalabraValida(palabra) {
  const p = normalizar(palabra);
  if (p.length < LARGO_MIN || p.length > LARGO_MAX) return false;
  return /^[A-ZÑ]+$/.test(p);
}

/**
 * Evaluacion estilo Wordle con manejo correcto de letras repetidas:
 * primero se marcan las correctas, y solo las sobrantes alimentan los "presente".
 */
function evaluarIntento(intento, palabra) {
  const a = normalizar(intento).split('');
  const b = normalizar(palabra).split('');
  const resultado = new Array(a.length).fill('ausente');
  const disponibles = {};

  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) {
      resultado[i] = 'correcta';
    } else {
      disponibles[b[i]] = (disponibles[b[i]] || 0) + 1;
    }
  }
  for (let i = 0; i < a.length; i++) {
    if (resultado[i] === 'correcta') continue;
    if (disponibles[a[i]] > 0) {
      resultado[i] = 'presente';
      disponibles[a[i]] -= 1;
    }
  }
  return resultado;
}

/**
 * Menos intentos, mas puntos. 1 intento = 100, y baja 10 por intento
 * con piso de 20. El primero en acertar se lleva +10 de bonus.
 */
function puntajeAdivinador(intentos, esPrimero) {
  const base = Math.max(20, 110 - 10 * intentos);
  return base + (esPrimero ? 10 : 0);
}

/** El escritor gana 15 por cada jugador que descubrio su palabra. */
function puntajeEscritor(cuantosAcertaron) {
  return 15 * cuantosAcertaron;
}

function mezclar(lista) {
  const copia = lista.slice();
  for (let i = copia.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copia[i], copia[j]] = [copia[j], copia[i]];
  }
  return copia;
}

function generarCodigo(largo = 4) {
  let codigo = '';
  for (let i = 0; i < largo; i++) {
    codigo += CODIGO_ALFABETO[Math.floor(Math.random() * CODIGO_ALFABETO.length)];
  }
  return codigo;
}

function limpiarConfig(config = {}) {
  const n = (valor, def, min, max) => {
    const x = Number.parseInt(valor, 10);
    if (Number.isNaN(x)) return def;
    return Math.min(max, Math.max(min, x));
  };
  return {
    rondas: n(config.rondas, 2, 1, 10),
    maxJugadores: n(config.maxJugadores, 6, 2, 12),
    segundosPorTurno: n(config.segundosPorTurno, 180, 0, 900), // 0 = sin limite
    pistaObligatoria: Boolean(config.pistaObligatoria),
  };
}

class Sala {
  constructor({ codigo, visibilidad = 'publica', config = {}, nombre = '' } = {}) {
    this.codigo = codigo || generarCodigo();
    this.nombre = String(nombre || '').slice(0, 40);
    this.visibilidad = visibilidad === 'privada' ? 'privada' : 'publica';
    this.config = limpiarConfig(config);
    this.jugadores = [];
    this.hostId = null;
    this.fase = FASES.LOBBY;
    this.ronda = 0;
    this.orden = [];
    this.indiceTurno = 0;
    this.turno = null;
    this.registro = [];
    this.creadaEn = Date.now();
    this.ultimaActividad = Date.now();
  }

  // ---------- jugadores ----------

  jugador(id) {
    return this.jugadores.find((j) => j.id === id) || null;
  }

  get activos() {
    return this.jugadores.filter((j) => j.conectado);
  }

  agregarJugador({ id, nombre }) {
    const existente = this.jugador(id);
    if (existente) {
      existente.conectado = true;
      if (nombre) existente.nombre = this.nombreLibre(nombre, id);
      this.ultimaActividad = Date.now();
      return { ok: true, jugador: existente, reconexion: true };
    }
    if (this.fase !== FASES.LOBBY) {
      return { ok: false, error: 'La partida ya empezó. Pídeles el código cuando terminen.' };
    }
    if (this.jugadores.length >= this.config.maxJugadores) {
      return { ok: false, error: 'La sala está llena.' };
    }
    const jugador = {
      id,
      nombre: this.nombreLibre(nombre, id),
      puntos: 0,
      conectado: true,
      palabrasAcertadas: 0,
    };
    this.jugadores.push(jugador);
    if (!this.hostId) this.hostId = id;
    this.ultimaActividad = Date.now();
    return { ok: true, jugador, reconexion: false };
  }

  nombreLibre(nombre, idPropio) {
    let base = String(nombre || '').trim().slice(0, 16) || 'Jugador';
    const tomado = (n) =>
      this.jugadores.some((j) => j.id !== idPropio && j.nombre.toLowerCase() === n.toLowerCase());
    if (!tomado(base)) return base;
    for (let i = 2; i < 30; i++) {
      const intento = `${base} ${i}`;
      if (!tomado(intento)) return intento;
    }
    return `${base} ${Math.floor(Math.random() * 999)}`;
  }

  desconectar(id) {
    const j = this.jugador(id);
    if (!j) return;
    j.conectado = false;
    this.ultimaActividad = Date.now();
    if (this.fase === FASES.LOBBY) {
      this.jugadores = this.jugadores.filter((x) => x.id !== id);
    }
    if (this.hostId === id) {
      const siguiente = this.activos[0];
      this.hostId = siguiente ? siguiente.id : this.hostId;
    }
  }

  // ---------- partida ----------

  iniciar(porId) {
    if (porId !== this.hostId) return { ok: false, error: 'Solo el anfitrión puede empezar.' };
    if (this.fase !== FASES.LOBBY) return { ok: false, error: 'La partida ya empezó.' };
    if (this.activos.length < 2) return { ok: false, error: 'Hacen falta al menos 2 jugadores.' };

    this.orden = mezclar(this.activos.map((j) => j.id));
    this.ronda = 1;
    this.indiceTurno = 0;
    this.registro = [];
    this.anotar(`Arranca la partida: ${this.config.rondas} ronda(s), ${this.orden.length} jugadores.`);
    this.abrirTurno();
    return { ok: true };
  }

  abrirTurno() {
    const escritorId = this.orden[this.indiceTurno];
    this.fase = FASES.ESCRIBIENDO;
    this.turno = {
      escritorId,
      palabra: null,
      pista: '',
      intentos: {},
      resueltos: [],
      rendidos: [],
      venceEn: null,
    };
    const escritor = this.jugador(escritorId);
    this.anotar(`Ronda ${this.ronda}: le toca escribir a ${escritor ? escritor.nombre : '?'}.`);
    this.ultimaActividad = Date.now();
  }

  get escritorId() {
    return this.turno ? this.turno.escritorId : null;
  }

  esEscritor(id) {
    return this.escritorId === id;
  }

  definirPalabra(id, palabra, pista) {
    if (this.fase !== FASES.ESCRIBIENDO) return { ok: false, error: 'Todavía no es momento de escribir.' };
    if (!this.esEscritor(id)) return { ok: false, error: 'No es tu turno de escribir.' };
    if (!esPalabraValida(palabra)) {
      return {
        ok: false,
        error: `La palabra debe tener entre ${LARGO_MIN} y ${LARGO_MAX} letras, sin numeros ni espacios.`,
      };
    }
    const limpia = String(pista || '').trim().slice(0, 120);
    if (this.config.pistaObligatoria && !limpia) {
      return { ok: false, error: 'En esta sala la pista es obligatoria.' };
    }
    this.turno.palabra = normalizar(palabra);
    this.turno.pista = limpia;
    this.fase = FASES.ADIVINANDO;
    this.turno.venceEn =
      this.config.segundosPorTurno > 0 ? Date.now() + this.config.segundosPorTurno * 1000 : null;
    const escritor = this.jugador(id);
    this.anotar(
      `${escritor ? escritor.nombre : '?'} ya eligió una palabra de ${this.turno.palabra.length} letras.` +
        (limpia ? ` Pista: "${limpia}"` : '')
    );
    this.ultimaActividad = Date.now();
    return { ok: true };
  }

  adivinar(id, intento) {
    if (this.fase !== FASES.ADIVINANDO) return { ok: false, error: 'Todavía no hay palabra que adivinar.' };
    if (this.esEscritor(id)) return { ok: false, error: 'Esta ronda la palabra es tuya.' };
    const jugador = this.jugador(id);
    if (!jugador) return { ok: false, error: 'No estas en la sala.' };
    if (this.turno.resueltos.some((r) => r.id === id)) {
      return { ok: false, error: 'Ya la descubriste.' };
    }
    if (this.turno.rendidos.includes(id)) return { ok: false, error: 'Ya te rendiste con esta palabra.' };

    const limpio = normalizar(intento);
    if (limpio.length !== this.turno.palabra.length) {
      return { ok: false, error: `La palabra tiene ${this.turno.palabra.length} letras.` };
    }
    if (!/^[A-ZÑ]+$/.test(limpio)) return { ok: false, error: 'Usa solo letras.' };

    const mios = this.turno.intentos[id] || (this.turno.intentos[id] = []);
    if (mios.length >= MAX_INTENTOS) return { ok: false, error: 'Llegaste al tope de intentos.' };
    if (mios.some((x) => x.palabra === limpio)) {
      return { ok: false, error: 'Ya probaste esa palabra.' };
    }

    const feedback = evaluarIntento(limpio, this.turno.palabra);
    mios.push({ palabra: limpio, feedback });
    this.ultimaActividad = Date.now();

    const acerto = feedback.every((f) => f === 'correcta');
    if (acerto) {
      const esPrimero = this.turno.resueltos.length === 0;
      const puntos = puntajeAdivinador(mios.length, esPrimero);
      jugador.puntos += puntos;
      jugador.palabrasAcertadas += 1;
      this.turno.resueltos.push({ id, intentos: mios.length, puntos, esPrimero });
      this.anotar(
        `${jugador.nombre} descubrió la palabra en ${mios.length} intento(s): +${puntos} puntos.` +
          (esPrimero ? ' (¡primero!)' : '')
      );
    }

    return { ok: true, feedback, acerto, intentos: mios.length };
  }

  rendirse(id) {
    if (this.fase !== FASES.ADIVINANDO) return { ok: false, error: 'No hay nada de lo que rendirse.' };
    if (this.esEscritor(id)) return { ok: false, error: 'Eres el escritor de esta ronda.' };
    if (this.turno.rendidos.includes(id)) return { ok: false, error: 'Ya te rendiste.' };
    if (this.turno.resueltos.some((r) => r.id === id)) return { ok: false, error: 'Ya acertaste.' };
    this.turno.rendidos.push(id);
    const j = this.jugador(id);
    this.anotar(`${j ? j.nombre : '?'} se rindió con esta palabra.`);
    this.ultimaActividad = Date.now();
    return { ok: true };
  }

  /** Adivinadores que siguen conectados y todavia pueden jugar el turno. */
  get pendientes() {
    if (!this.turno) return [];
    return this.activos.filter(
      (j) =>
        j.id !== this.turno.escritorId &&
        !this.turno.resueltos.some((r) => r.id === j.id) &&
        !this.turno.rendidos.includes(j.id)
    );
  }

  get turnoCompleto() {
    return this.fase === FASES.ADIVINANDO && this.pendientes.length === 0;
  }

  get tiempoAgotado() {
    return Boolean(this.turno && this.turno.venceEn && Date.now() >= this.turno.venceEn);
  }

  /** Cierra el turno actual y reparte el puntaje del escritor. */
  cerrarTurno(motivo = 'listo') {
    if (this.fase !== FASES.ADIVINANDO && this.fase !== FASES.ESCRIBIENDO) {
      return { ok: false, error: 'No hay turno abierto.' };
    }
    const escritor = this.jugador(this.turno.escritorId);

    if (this.fase === FASES.ESCRIBIENDO) {
      this.anotar(`${escritor ? escritor.nombre : '?'} no alcanzó a escribir una palabra. Turno perdido.`);
      this.turno.palabra = this.turno.palabra || '';
    } else {
      const acertaron = this.turno.resueltos.length;
      const puntos = puntajeEscritor(acertaron);
      if (escritor) escritor.puntos += puntos;
      if (acertaron === 0) {
        this.anotar(
          `Nadie descubrió "${this.turno.palabra}". ${escritor ? escritor.nombre : '?'} no suma puntos.`
        );
      } else {
        this.anotar(
          `La palabra era "${this.turno.palabra}". ` +
            `${acertaron === 1 ? 'La descubrió 1 jugador' : `La descubrieron ${acertaron} jugadores`}: ` +
            `${escritor ? escritor.nombre : '?'} +${puntos} puntos.`
        );
      }
      if (motivo === 'tiempo') this.anotar('Se acabó el tiempo del turno.');
    }

    this.turno.venceEn = null;
    this.fase = FASES.RESUMEN;
    this.ultimaActividad = Date.now();
    return { ok: true };
  }

  /** Pasa al siguiente escritor, a la siguiente ronda, o termina la partida. */
  avanzar() {
    if (this.fase !== FASES.RESUMEN) return { ok: false, error: 'El turno sigue en juego.' };
    this.indiceTurno += 1;
    if (this.indiceTurno >= this.orden.length) {
      this.indiceTurno = 0;
      this.ronda += 1;
    }
    if (this.ronda > this.config.rondas) {
      this.fase = FASES.FIN;
      this.turno = null;
      const tabla = this.tablaPosiciones();
      const campeon = tabla[0];
      this.anotar(
        campeon
          ? `Fin de la partida. Gana ${campeon.nombre} con ${campeon.puntos} puntos.`
          : 'Fin de la partida.'
      );
      this.ultimaActividad = Date.now();
      return { ok: true, fin: true };
    }
    this.abrirTurno();
    return { ok: true, fin: false };
  }

  /** Vuelve al lobby manteniendo los jugadores, para la revancha. */
  reiniciar(porId) {
    if (porId !== this.hostId) return { ok: false, error: 'Solo el anfitrión puede dar revancha.' };
    this.fase = FASES.LOBBY;
    this.ronda = 0;
    this.orden = [];
    this.indiceTurno = 0;
    this.turno = null;
    this.registro = [];
    this.jugadores.forEach((j) => {
      j.puntos = 0;
      j.palabrasAcertadas = 0;
    });
    this.jugadores = this.jugadores.filter((j) => j.conectado);
    this.anotar('Revancha: todos de vuelta al lobby.');
    this.ultimaActividad = Date.now();
    return { ok: true };
  }

  cambiarConfig(porId, config) {
    if (porId !== this.hostId) return { ok: false, error: 'Solo el anfitrión puede configurar la sala.' };
    if (this.fase !== FASES.LOBBY) return { ok: false, error: 'No se puede cambiar en medio de la partida.' };
    const nueva = limpiarConfig({ ...this.config, ...config });
    if (nueva.maxJugadores < this.jugadores.length) {
      return { ok: false, error: `Ya hay ${this.jugadores.length} jugadores en la sala.` };
    }
    this.config = nueva;
    if (config.visibilidad) {
      this.visibilidad = config.visibilidad === 'privada' ? 'privada' : 'publica';
    }
    this.ultimaActividad = Date.now();
    return { ok: true };
  }

  anotar(texto) {
    this.registro.push({ en: Date.now(), texto });
    if (this.registro.length > 80) this.registro.shift();
  }

  tablaPosiciones() {
    return this.jugadores
      .slice()
      .sort((a, b) => b.puntos - a.puntos || b.palabrasAcertadas - a.palabrasAcertadas)
      .map((j, i) => ({ puesto: i + 1, id: j.id, nombre: j.nombre, puntos: j.puntos, palabrasAcertadas: j.palabrasAcertadas }));
  }

  /** Total de turnos de la partida, para mostrar el progreso. */
  get turnosTotales() {
    return this.orden.length * this.config.rondas;
  }

  /**
   * Estado visible para un jugador. La palabra solo viaja al escritor,
   * y al resto cuando el turno ya cerro.
   */
  estadoPara(id) {
    const mostrarPalabra = this.fase === FASES.RESUMEN || this.fase === FASES.FIN || this.esEscritor(id);
    const turno = this.turno
      ? {
          escritorId: this.turno.escritorId,
          escritorNombre: (this.jugador(this.turno.escritorId) || {}).nombre || '?',
          soyEscritor: this.esEscritor(id),
          largoPalabra: this.turno.palabra ? this.turno.palabra.length : null,
          pista: this.turno.pista,
          palabra: mostrarPalabra ? this.turno.palabra : null,
          venceEn: this.turno.venceEn,
          misIntentos: this.turno.intentos[id] || [],
          resueltos: this.turno.resueltos.map((r) => ({
            ...r,
            nombre: (this.jugador(r.id) || {}).nombre || '?',
          })),
          rendidos: this.turno.rendidos,
          progreso: this.jugadores
            .filter((j) => j.id !== this.turno.escritorId)
            .map((j) => ({
              id: j.id,
              nombre: j.nombre,
              conectado: j.conectado,
              intentos: (this.turno.intentos[j.id] || []).length,
              acerto: this.turno.resueltos.some((r) => r.id === j.id),
              rendido: this.turno.rendidos.includes(j.id),
            })),
        }
      : null;

    return {
      codigo: this.codigo,
      nombre: this.nombre,
      visibilidad: this.visibilidad,
      config: this.config,
      fase: this.fase,
      ronda: this.ronda,
      rondas: this.config.rondas,
      turnoActual: this.orden.length ? this.indiceTurno + 1 : 0,
      turnosPorRonda: this.orden.length,
      hostId: this.hostId,
      soyHost: this.hostId === id,
      yoId: id,
      jugadores: this.jugadores.map((j) => ({
        id: j.id,
        nombre: j.nombre,
        puntos: j.puntos,
        conectado: j.conectado,
        palabrasAcertadas: j.palabrasAcertadas,
        esEscritor: this.escritorId === j.id,
        esHost: this.hostId === j.id,
      })),
      turno,
      registro: this.registro.slice(-30),
      tabla: this.fase === FASES.FIN ? this.tablaPosiciones() : null,
      limites: { largoMin: LARGO_MIN, largoMax: LARGO_MAX, maxIntentos: MAX_INTENTOS },
    };
  }

  resumenPublico() {
    return {
      codigo: this.codigo,
      nombre: this.nombre,
      jugadores: this.jugadores.length,
      maxJugadores: this.config.maxJugadores,
      rondas: this.config.rondas,
      fase: this.fase,
      enJuego: this.fase !== FASES.LOBBY && this.fase !== FASES.FIN,
    };
  }
}

module.exports = {
  Sala,
  FASES,
  LARGO_MIN,
  LARGO_MAX,
  MAX_INTENTOS,
  normalizar,
  esPalabraValida,
  evaluarIntento,
  puntajeAdivinador,
  puntajeEscritor,
  generarCodigo,
  limpiarConfig,
};

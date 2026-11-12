/* Palabrear — cliente */
'use strict';

const $ = (id) => document.getElementById(id);

/* ---------- identidad persistente ---------- */

function idPersistente() {
  let id = localStorage.getItem('palabrear:id');
  if (!id) {
    id = (crypto.randomUUID && crypto.randomUUID()) || `j${Date.now()}${Math.random().toString(36).slice(2)}`;
    localStorage.setItem('palabrear:id', id);
  }
  return id;
}

const socket = io({ auth: { jugadorId: idPersistente() } });

/* ---------- tema (claro por defecto) ---------- */

function temaActual() {
  return document.documentElement.dataset.tema === 'oscuro' ? 'oscuro' : 'claro';
}

function aplicarTema(tema) {
  if (tema === 'oscuro') document.documentElement.dataset.tema = 'oscuro';
  else delete document.documentElement.dataset.tema;
  try {
    localStorage.setItem('palabrear:tema', tema);
  } catch (e) {}
  const oscuro = tema === 'oscuro';
  const color = document.querySelector('meta[name="theme-color"]');
  if (color) color.setAttribute('content', oscuro ? '#141318' : '#f7f2e9');
  for (const id of ['btn-tema-inicio', 'btn-tema-sala']) {
    const btn = $(id);
    if (!btn) continue;
    btn.textContent = oscuro ? '☀️' : '🌙';
    btn.title = oscuro ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro';
  }
}

for (const id of ['btn-tema-inicio', 'btn-tema-sala']) {
  const btn = $(id);
  if (btn) btn.addEventListener('click', () => aplicarTema(temaActual() === 'oscuro' ? 'claro' : 'oscuro'));
}

aplicarTema(temaActual());

let estado = null;        // ultimo estado recibido del servidor
let borrador = '';        // letras que estoy tecleando
let filasPintadas = 0;    // para animar solo la fila nueva
let ultimoTurnoClave = '';

/* ---------- avisos ---------- */

function avisar(texto) {
  const li = document.createElement('div');
  li.className = 'aviso';
  li.textContent = texto;
  $('avisos').appendChild(li);
  setTimeout(() => li.remove(), 3600);
}

/* ---------- inicio ---------- */

const nombreGuardado = localStorage.getItem('palabrear:nombre') || '';
$('in-nombre').value = nombreGuardado;

function miNombre() {
  const n = $('in-nombre').value.trim();
  if (n) localStorage.setItem('palabrear:nombre', n);
  return n || 'Jugador';
}

function errorInicio(texto) {
  const p = $('error-inicio');
  p.textContent = texto || '';
  p.hidden = !texto;
}

$('btn-abrir-crear').addEventListener('click', () => {
  $('panel-crear').hidden = false;
  $('in-nombre-sala').focus();
});

$('btn-cancelar-crear').addEventListener('click', () => {
  $('panel-crear').hidden = true;
});

$('btn-crear').addEventListener('click', () => {
  errorInicio('');
  socket.emit(
    'crear',
    {
      nombre: miNombre(),
      nombreSala: $('in-nombre-sala').value.trim(),
      visibilidad: document.querySelector('input[name="visibilidad"]:checked').value,
      config: {
        modo: document.querySelector('input[name="modo"]:checked').value,
        rondas: $('in-rondas').value,
        maxJugadores: $('in-max').value,
        segundosPorTurno: $('in-sin-limite').checked ? 0 : $('in-tiempo').value,
        letrasPorPalabra: $('in-letras').value,
        pistaObligatoria: $('in-pista-obligatoria').checked,
      },
    },
    (r) => {
      if (!r || !r.ok) return errorInicio((r && r.error) || 'No se pudo crear la sala.');
      localStorage.setItem('palabrear:sala', r.codigo);
      location.hash = r.codigo;
    }
  );
});

function unirse(codigo) {
  errorInicio('');
  const limpio = String(codigo || '').trim().toUpperCase();
  if (!limpio) return errorInicio('Escribe el código de la sala.');
  socket.emit('unirse', { codigo: limpio, nombre: miNombre() }, (r) => {
    if (!r || !r.ok) {
      localStorage.removeItem('palabrear:sala');
      return errorInicio((r && r.error) || 'No se pudo entrar.');
    }
    localStorage.setItem('palabrear:sala', r.codigo);
    location.hash = r.codigo;
  });
}

$('btn-unirse').addEventListener('click', () => unirse($('in-codigo').value));
$('in-codigo').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') unirse($('in-codigo').value);
});

$('btn-refrescar').addEventListener('click', pedirSalas);

function pedirSalas() {
  socket.emit('salas', (lista) => {
    const ul = $('lista-salas');
    ul.innerHTML = '';
    if (!lista || !lista.length) {
      const li = document.createElement('li');
      li.className = 'vacio';
      li.textContent = 'No hay salas públicas abiertas. Crea una y comparte el código.';
      ul.appendChild(li);
      return;
    }
    for (const sala of lista) {
      const li = document.createElement('li');
      const izq = document.createElement('div');
      const titulo = document.createElement('div');
      titulo.innerHTML = `<span class="sala__codigo">${sala.codigo}</span>${
        sala.nombre ? ` · ${escapar(sala.nombre)}` : ''
      }`;
      const meta = document.createElement('div');
      meta.className = 'sala__meta';
      meta.textContent =
        `${sala.jugadores}/${sala.maxJugadores} jugadores · ${plural(sala.rondas, 'ronda', 'rondas')} · ` +
        `${nombreModo(sala.modo).toLowerCase()} · ${sala.enJuego ? 'jugando' : 'esperando'}`;
      izq.append(titulo, meta);

      const btn = document.createElement('button');
      btn.className = 'boton boton--chico';
      btn.textContent = sala.enJuego ? 'En juego' : 'Entrar';
      btn.disabled = sala.enJuego || sala.jugadores >= sala.maxJugadores;
      btn.addEventListener('click', () => unirse(sala.codigo));

      li.append(izq, btn);
      ul.appendChild(li);
    }
  });
}

function plural(n, singular, pluralForma) {
  return `${n} ${n === 1 ? singular : pluralForma}`;
}

function nombreModo(modo) {
  return modo === 'primero' ? 'El primero que adivine' : 'Por tiempo';
}

function escapar(texto) {
  const d = document.createElement('div');
  d.textContent = texto;
  return d.innerHTML;
}

/* ---------- sala: acciones ---------- */

$('btn-salir').addEventListener('click', salir);
$('btn-salir-fin').addEventListener('click', salir);

function salir() {
  socket.emit('salir');
  localStorage.removeItem('palabrear:sala');
  estado = null;
  location.hash = '';
  mostrarVista('inicio');
  pedirSalas();
}

$('btn-codigo').addEventListener('click', async () => {
  if (!estado) return;
  const enlace = `${location.origin}/#${estado.codigo}`;
  try {
    await navigator.clipboard.writeText(enlace);
    avisar('Enlace de la sala copiado.');
  } catch {
    avisar(`Código: ${estado.codigo}`);
  }
});

$('btn-compartir').addEventListener('click', async () => {
  if (!estado) return;
  const url = `${location.origin}/#${estado.codigo}`;
  const datos = {
    title: 'Palabrear',
    text: `¡Únete a mi sala de Palabrear! Código: ${estado.codigo}`,
    url,
  };
  if (navigator.share) {
    try {
      await navigator.share(datos);
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    avisar('Enlace de la sala copiado.');
  } catch {
    avisar(`Comparte este enlace: ${url}`);
  }
});

$('btn-empezar').addEventListener('click', () => {
  socket.emit('iniciar', {}, (r) => r && !r.ok && avisar(r.error));
});

$('btn-guardar-config').addEventListener('click', () => {
  socket.emit(
    'config',
    {
      modo: (document.querySelector('input[name="cfg-modo"]:checked') || {}).value,
      rondas: $('cfg-rondas').value,
      maxJugadores: $('cfg-max').value,
      segundosPorTurno: $('cfg-sin-limite').checked ? 0 : $('cfg-tiempo').value,
      letrasPorPalabra: $('cfg-letras').value,
    },
    (r) => avisar(r && r.ok ? 'Ajustes guardados.' : (r && r.error) || 'No se pudo guardar.')
  );
});

$('btn-enviar-palabra').addEventListener('click', enviarPalabra);
$('in-palabra').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') enviarPalabra();
});

function enviarPalabra() {
  const p = $('error-palabra');
  p.hidden = true;
  socket.emit('palabra', { palabra: $('in-palabra').value, pista: $('in-pista').value }, (r) => {
    if (r && !r.ok) {
      p.textContent = r.error;
      p.hidden = false;
      return;
    }
    $('in-palabra').value = '';
    $('in-pista').value = '';
  });
}

$('btn-rendirse').addEventListener('click', () => {
  if (!confirm('¿Te rindes con esta palabra? No sumas puntos en este turno.')) return;
  socket.emit('rendirse', {}, (r) => r && !r.ok && avisar(r.error));
});

$('btn-cortar').addEventListener('click', () => {
  socket.emit('siguiente', {}, (r) => r && !r.ok && avisar(r.error));
});

$('btn-siguiente').addEventListener('click', () => {
  socket.emit('siguiente', {}, (r) => r && !r.ok && avisar(r.error));
});

$('btn-revancha').addEventListener('click', () => {
  socket.emit('revancha', {}, (r) => r && !r.ok && avisar(r.error));
});

$('form-chat').addEventListener('submit', (e) => {
  e.preventDefault();
  const texto = $('in-chat').value.trim();
  if (!texto) return;
  socket.emit('chat', { texto });
  $('in-chat').value = '';
});

/* ---------- teclado en pantalla ---------- */

const FILAS_TECLADO = [
  ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'],
  ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L', 'Ñ'],
  ['ENVIAR', 'Z', 'X', 'C', 'V', 'B', 'N', 'M', 'BORRAR'],
];

function construirTeclado() {
  const cont = $('teclado');
  cont.innerHTML = '';
  for (const fila of FILAS_TECLADO) {
    const div = document.createElement('div');
    div.className = 'teclado__fila';
    for (const tecla of fila) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tecla' + (tecla.length > 1 ? ' tecla--ancha' : '');
      btn.dataset.tecla = tecla;
      btn.textContent = tecla === 'BORRAR' ? '⌫' : tecla;
      btn.addEventListener('click', () => pulsar(tecla));
      div.appendChild(btn);
    }
    cont.appendChild(div);
  }
}

construirTeclado();

function pulsar(tecla) {
  if (!estado || estado.fase !== 'adivinando' || !estado.turno || estado.turno.soyEscritor) return;
  if (yaTermine()) return;
  const largo = estado.turno.largoPalabra || 0;

  if (tecla === 'ENVIAR') return enviarIntento();
  if (tecla === 'BORRAR') {
    borrador = borrador.slice(0, -1);
    return pintarTablero();
  }
  if (borrador.length >= largo) return;
  borrador += tecla;
  pintarTablero();
}

document.addEventListener('keydown', (e) => {
  if (!estado || estado.fase !== 'adivinando') return;
  const activo = document.activeElement;
  if (activo && (activo.tagName === 'INPUT' || activo.tagName === 'TEXTAREA')) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  if (e.key === 'Enter') { e.preventDefault(); return pulsar('ENVIAR'); }
  if (e.key === 'Backspace') { e.preventDefault(); return pulsar('BORRAR'); }
  const letra = normalizarLetra(e.key);
  if (letra) { e.preventDefault(); pulsar(letra); }
});

function normalizarLetra(tecla) {
  if (!tecla || tecla.length !== 1) return null;
  const may = tecla
    .toUpperCase()
    .replace(/Ü/g, 'U')
    .normalize('NFD')
    .replace(/(?!̃)[̀-ͯ]/g, '')
    .normalize('NFC');
  return /^[A-ZÑ]$/.test(may) ? may : null;
}

function yaTermine() {
  if (!estado || !estado.turno) return true;
  const yo = estado.yoId;
  return (
    estado.turno.resueltos.some((r) => r.id === yo) || estado.turno.rendidos.includes(yo)
  );
}

function enviarIntento() {
  const largo = estado.turno.largoPalabra || 0;
  if (borrador.length !== largo) {
    marcarError(`Faltan letras: la palabra tiene ${largo}.`);
    return;
  }
  const intento = borrador;
  socket.emit('adivinar', { intento }, (r) => {
    if (!r || !r.ok) return marcarError((r && r.error) || 'No se pudo enviar.');
    borrador = '';
    if (r.acerto) {
      mensajeIntento(`¡La tenías! ${plural(r.intentos, 'intento', 'intentos')}.`, 'exito');
    } else {
      mensajeIntento(`Intento ${r.intentos}. Sigue.`, '');
    }
  });
}

function marcarError(texto) {
  mensajeIntento(texto, 'error');
  const filaActiva = document.querySelector('.fila--activa');
  if (filaActiva) {
    filaActiva.classList.remove('fila--error');
    void filaActiva.offsetWidth;
    filaActiva.classList.add('fila--error');
  }
}

function mensajeIntento(texto, tipo) {
  const p = $('estado-intento');
  p.textContent = texto;
  p.className = 'estado-intento' + (tipo ? ` estado-intento--${tipo}` : '');
}

/* ---------- vistas ---------- */

function mostrarVista(cual) {
  $('vista-inicio').hidden = cual !== 'inicio';
  $('vista-sala').hidden = cual !== 'sala';
}

const FASES_PANEL = [
  'fase-lobby',
  'fase-escribir',
  'fase-esperando-palabra',
  'fase-adivinar',
  'fase-mirando',
  'fase-resumen',
  'fase-fin',
];

function soloPanel(id) {
  for (const panel of FASES_PANEL) $(panel).hidden = panel !== id;
}

/* ---------- pintado del estado ---------- */

socket.on('estado', (nuevo) => {
  const turnoClave = `${nuevo.ronda}-${nuevo.turnoActual}-${nuevo.fase === 'adivinando' ? 'a' : nuevo.fase}`;
  if (turnoClave !== ultimoTurnoClave) {
    ultimoTurnoClave = turnoClave;
    borrador = '';
    filasPintadas = 0;
    mensajeIntento('', '');
  }
  estado = nuevo;
  mostrarVista('sala');
  pintar();
});

socket.on('aviso', (texto) => avisar(texto));

socket.on('chat', ({ nombre, texto }) => {
  const ul = $('chat');
  const li = document.createElement('li');
  li.innerHTML = `<span class="de">${escapar(nombre)}:</span> ${escapar(texto)}`;
  ul.appendChild(li);
  while (ul.children.length > 60) ul.removeChild(ul.firstChild);
  ul.scrollTop = ul.scrollHeight;
});

socket.on('connect', () => {
  const guardada = localStorage.getItem('palabrear:sala');
  const delEnlace = location.hash.replace('#', '').toUpperCase();
  const codigo = delEnlace || guardada;
  // Invitacion nueva (no es una reconexion a mi sala): primero pedir el nombre.
  if (delEnlace && delEnlace !== guardada && /^[A-Z0-9]{4,6}$/.test(delEnlace) && !estado) {
    pedirNombreInvitacion(delEnlace);
    pedirSalas();
    return;
  }
  if (codigo && /^[A-Z0-9]{4,6}$/.test(codigo)) {
    socket.emit('unirse', { codigo, nombre: miNombre() }, (r) => {
      if (!r || !r.ok) {
        localStorage.removeItem('palabrear:sala');
        if (delEnlace) {
          $('in-codigo').value = delEnlace;
          errorInicio((r && r.error) || 'Esa sala ya no está disponible.');
        }
        mostrarVista('inicio');
        pedirSalas();
      } else {
        localStorage.setItem('palabrear:sala', r.codigo);
      }
    });
  } else {
    pedirSalas();
  }
});

socket.on('disconnect', () => avisar('Se cortó la conexión. Reintentando…'));

function pintar() {
  if (!estado) return;

  $('sala-nombre').textContent = estado.nombre || 'Sala de Palabrear';
  $('btn-codigo').textContent = estado.codigo;

  if (estado.fase === 'lobby') {
    $('sala-progreso').textContent = `${estado.jugadores.length} en la sala · ${estado.visibilidad}`;
  } else if (estado.fase === 'fin') {
    $('sala-progreso').textContent = 'Partida terminada';
  } else {
    $('sala-progreso').textContent = `Ronda ${estado.ronda}/${estado.rondas} · turno ${estado.turnoActual}/${estado.turnosPorRonda}`;
  }

  pintarMarcador();
  pintarRegistro();

  switch (estado.fase) {
    case 'lobby': pintarLobby(); break;
    case 'escribiendo': pintarEscribiendo(); break;
    case 'adivinando': pintarAdivinando(); break;
    case 'resumen': pintarResumen(); break;
    case 'fin': pintarFin(); break;
  }
}

function pintarLobby() {
  soloPanel('fase-lobby');
  $('lobby-codigo').textContent = estado.codigo;
  const c = estado.config;
  $('lobby-config').innerHTML =
    `<span class="destacada">${nombreModo(c.modo)}</span>` +
    [
      plural(c.rondas, 'ronda', 'rondas'),
      `hasta ${c.maxJugadores} jugadores`,
      c.segundosPorTurno ? `${c.segundosPorTurno}s por turno` : 'sin límite de tiempo',
      c.letrasPorPalabra ? `palabras de ${c.letrasPorPalabra} letras` : 'palabras de 3 a 12 letras',
      c.pistaObligatoria ? 'pista obligatoria' : 'pista opcional',
      estado.visibilidad === 'privada' ? 'sala privada' : 'sala pública',
    ]
      .map((t) => `<span>${t}</span>`)
      .join('');

  $('lobby-host-config').hidden = !estado.soyHost;
  $('lobby-espera').hidden = estado.soyHost;
  if (estado.soyHost) {
    const radio = document.querySelector(`input[name="cfg-modo"][value="${c.modo}"]`);
    if (radio && !document.querySelector('input[name="cfg-modo"]:checked')) radio.checked = true;
    if (document.activeElement !== $('cfg-rondas')) $('cfg-rondas').value = c.rondas;
    if (document.activeElement !== $('cfg-max')) $('cfg-max').value = c.maxJugadores;
    if (document.activeElement !== $('cfg-tiempo')) $('cfg-tiempo').value = c.segundosPorTurno || 180;
    if (document.activeElement !== $('cfg-sin-limite')) {
      $('cfg-sin-limite').checked = !c.segundosPorTurno;
      $('cfg-tiempo').disabled = !c.segundosPorTurno;
    }
    if (document.activeElement !== $('cfg-letras')) $('cfg-letras').value = String(c.letrasPorPalabra || 0);
    $('btn-empezar').disabled = estado.jugadores.filter((j) => j.conectado).length < 2;
  }
}

function pintarEscribiendo() {
  if (estado.turno && estado.turno.soyEscritor) {
    soloPanel('fase-escribir');
    const fijo = estado.config.letrasPorPalabra;
    $('in-palabra').maxLength = fijo || 12;
    if ($('in-palabra').value.length > $('in-palabra').maxLength) {
      $('in-palabra').value = $('in-palabra').value.slice(0, $('in-palabra').maxLength);
    }
    $('texto-escribir').textContent =
      `Elige una palabra de ${fijo ? `exactamente ${fijo}` : '3 a 12'} letras. Si quieres, deja una pista.`;
    $('pista-opcional').textContent = estado.config.pistaObligatoria ? '(obligatoria)' : '(opcional)';
    if (document.activeElement !== $('in-palabra') && document.activeElement !== $('in-pista')) {
      $('in-palabra').focus();
    }
  } else {
    soloPanel('fase-esperando-palabra');
    $('esperando-nombre').textContent = estado.turno ? estado.turno.escritorNombre : '';
  }
}

function pintarAdivinando() {
  const alPrimero = estado.config.modo === 'primero';

  if (estado.turno.soyEscritor) {
    soloPanel('fase-mirando');
    $('mirando-palabra').textContent = estado.turno.palabra || '';
    $('mirando-nota').textContent = alPrimero
      ? 'Ganas 20 puntos si alguno la descubre. El turno se corta con el primer acierto.'
      : 'Ganas 15 puntos por cada jugador que la descubra.';
    const ul = $('mirando-progreso');
    ul.innerHTML = '';
    for (const p of estado.turno.progreso) {
      const li = document.createElement('li');
      const nombre = document.createElement('span');
      nombre.textContent = p.nombre + (p.conectado ? '' : ' (fuera)');
      const estadoTxt = document.createElement('span');
      if (p.acerto) {
        estadoTxt.className = 'insignia insignia--ok';
        estadoTxt.textContent = `acertó en ${p.intentos}`;
      } else if (p.rendido) {
        estadoTxt.className = 'insignia';
        estadoTxt.textContent = 'se rindió';
      } else {
        estadoTxt.className = 'insignia';
        estadoTxt.textContent = plural(p.intentos, 'intento', 'intentos');
      }
      const cabeza = document.createElement('div');
      cabeza.className = 'progreso__cabeza';
      cabeza.append(nombre, estadoTxt);
      li.appendChild(cabeza);
      li.appendChild(miniTablero(p.detalle || [], estado.turno.largoPalabra));
      ul.appendChild(li);
    }
    return;
  }

  soloPanel('fase-adivinar');
  $('adivinar-escritor').textContent = estado.turno.escritorNombre;
  $('adivinar-largo').textContent = estado.turno.largoPalabra;
  $('adivinar-modo').textContent = alPrimero
    ? 'Gana el primero que acierte. Si no llegas, igual cobras por tus verdes y amarillas.'
    : 'Mientras menos intentos te tome, más puntos.';
  const pista = $('adivinar-pista');
  if (estado.turno.pista) {
    pista.textContent = `Pista: ${estado.turno.pista}`;
    pista.hidden = false;
  } else {
    pista.hidden = true;
  }
  $('btn-rendirse').hidden = yaTermine();
  pintarTablero();
  pintarTeclado();
}

/** Tablero chico con los intentos de otro jugador, para la vista del escritor. */
function miniTablero(intentos, largo) {
  const caja = document.createElement('div');
  caja.className = 'mini';
  if (!intentos.length) {
    const vacio = document.createElement('small');
    vacio.className = 'mini__vacio';
    vacio.textContent = 'Todavía sin intentos…';
    caja.appendChild(vacio);
    return caja;
  }
  for (const it of intentos) {
    const fila = document.createElement('div');
    fila.className = 'mini__fila';
    fila.style.gridTemplateColumns = `repeat(${largo}, auto)`;
    it.palabra.split('').forEach((letra, k) => {
      const c = document.createElement('span');
      c.className = `mini__casilla casilla--${it.feedback[k]}`;
      c.textContent = letra;
      fila.appendChild(c);
    });
    caja.appendChild(fila);
  }
  return caja;
}

function pintarTablero() {
  if (!estado || !estado.turno) return;
  const cont = $('tablero');
  const largo = estado.turno.largoPalabra || 0;
  const intentos = estado.turno.misIntentos || [];
  cont.innerHTML = '';

  intentos.forEach((intento, i) => {
    const fila = document.createElement('div');
    fila.className = 'fila';
    fila.style.gridTemplateColumns = `repeat(${largo}, auto)`;
    if (i >= filasPintadas) fila.classList.add('fila--nueva');
    for (let k = 0; k < largo; k++) {
      const casilla = document.createElement('div');
      casilla.className = `casilla casilla--${intento.feedback[k]}`;
      casilla.textContent = intento.palabra[k] || '';
      fila.appendChild(casilla);
    }
    cont.appendChild(fila);
  });
  filasPintadas = intentos.length;

  if (!yaTermine()) {
    const fila = document.createElement('div');
    fila.className = 'fila fila--activa';
    fila.style.gridTemplateColumns = `repeat(${largo}, auto)`;
    for (let k = 0; k < largo; k++) {
      const casilla = document.createElement('div');
      casilla.className = 'casilla' + (borrador[k] ? ' casilla--llena' : '');
      casilla.textContent = borrador[k] || '';
      fila.appendChild(casilla);
    }
    cont.appendChild(fila);
  }
}

function pintarTeclado() {
  const mejor = {}; // letra -> mejor estado conocido
  const rango = { ausente: 1, presente: 2, correcta: 3 };
  for (const intento of estado.turno.misIntentos || []) {
    intento.palabra.split('').forEach((letra, i) => {
      const f = intento.feedback[i];
      if (!mejor[letra] || rango[f] > rango[mejor[letra]]) mejor[letra] = f;
    });
  }
  for (const btn of document.querySelectorAll('.tecla')) {
    const tecla = btn.dataset.tecla;
    btn.className = 'tecla' + (tecla.length > 1 ? ' tecla--ancha' : '');
    if (mejor[tecla]) btn.classList.add(`tecla--${mejor[tecla]}`);
  }
}

function pintarResumen() {
  soloPanel('fase-resumen');
  $('resumen-palabra').textContent = (estado.turno && estado.turno.palabra) || '—';
  const ul = $('resumen-lista');
  ul.innerHTML = '';

  const turno = estado.turno;
  const resueltos = (turno && turno.resueltos) || [];
  const alPrimero = estado.config.modo === 'primero';

  if (!resueltos.length) {
    const li = document.createElement('li');
    li.innerHTML = '<span>Nadie la descubrió esta vez.</span>';
    ul.appendChild(li);
  }

  for (const r of resueltos) {
    const li = document.createElement('li');
    if (alPrimero) li.classList.add('ganador');
    const detalle = alPrimero
      ? `Llegó primero en ${plural(r.intentos, 'intento', 'intentos')}`
      : `${plural(r.intentos, 'intento', 'intentos')}${r.esPrimero ? ' · primero' : ''}`;
    li.innerHTML =
      `<span>${escapar(r.nombre)}<span class="detalle">${detalle}</span></span>` +
      `<span class="gano">+${r.puntos}</span>`;
    ul.appendChild(li);
  }

  // Modo "el primero que adivine": el resto cobra por las letras que llevaba.
  for (const c of (turno && turno.consuelos) || []) {
    const li = document.createElement('li');
    const letras = [];
    if (c.verdes) letras.push(plural(c.verdes, 'verde', 'verdes'));
    if (c.amarillas) letras.push(plural(c.amarillas, 'amarilla', 'amarillas'));
    li.innerHTML =
      `<span>${escapar(c.nombre)}<span class="detalle">${
        letras.length ? letras.join(' y ') : 'sin letras acertadas'
      }</span></span>` +
      (c.puntos ? `<span class="gano">+${c.puntos}</span>` : '<span class="nada">0</span>');
    ul.appendChild(li);
  }

  if (turno) {
    const li = document.createElement('li');
    li.innerHTML =
      `<span>${escapar(turno.escritorNombre)}<span class="detalle">escribió la palabra</span></span>` +
      (turno.puntosEscritor
        ? `<span class="gano">+${turno.puntosEscritor}</span>`
        : '<span class="nada">0</span>');
    ul.appendChild(li);
  }
  $('btn-siguiente').hidden = !estado.soyHost;
}

function pintarFin() {
  soloPanel('fase-fin');
  const ol = $('podio');
  ol.innerHTML = '';
  for (const fila of estado.tabla || []) {
    const li = document.createElement('li');
    const medalla = fila.puesto === 1 ? '🏆' : fila.puesto;
    li.innerHTML =
      `<span class="puesto">${medalla}</span>` +
      `<span class="quien"><strong>${escapar(fila.nombre)}</strong>` +
      `<span class="detalle">${plural(fila.palabrasAcertadas, 'palabra descubierta', 'palabras descubiertas')}</span></span>` +
      `<span class="total">${fila.puntos}</span>`;
    ol.appendChild(li);
  }
  $('btn-revancha').hidden = !estado.soyHost;
}

function pintarMarcador() {
  const ul = $('marcador');
  ul.innerHTML = '';
  const ordenados = estado.jugadores.slice().sort((a, b) => b.puntos - a.puntos);
  for (const j of ordenados) {
    const li = document.createElement('li');
    if (j.id === estado.yoId) li.classList.add('yo');
    if (!j.conectado) li.classList.add('desconectado');
    const nombre = document.createElement('div');
    nombre.className = 'nombre';
    nombre.innerHTML =
      `<span>${escapar(j.nombre)}</span>` +
      (j.esEscritor ? '<span class="insignia insignia--escritor">escribe</span>' : '') +
      (j.esHost ? '<span class="insignia">anfitrión</span>' : '');
    const puntos = document.createElement('div');
    puntos.className = 'puntos';
    puntos.textContent = j.puntos;
    li.append(nombre, puntos);
    ul.appendChild(li);
  }
}

function pintarRegistro() {
  const ul = $('registro');
  ul.innerHTML = '';
  for (const linea of (estado.registro || []).slice(-15).reverse()) {
    const li = document.createElement('li');
    li.textContent = linea.texto;
    ul.appendChild(li);
  }
}

/* ---------- relojes ---------- */

setInterval(() => {
  if (!estado) return;

  const reloj = $('sala-reloj');
  const vence = estado.turno && estado.turno.venceEn;
  if (vence && (estado.fase === 'escribiendo' || estado.fase === 'adivinando')) {
    const restan = Math.max(0, Math.ceil((vence - Date.now()) / 1000));
    const min = Math.floor(restan / 60);
    const seg = String(restan % 60).padStart(2, '0');
    reloj.textContent = `⏱ ${min}:${seg}`;
    reloj.classList.toggle('reloj--urgente', restan <= 20);
    reloj.classList.toggle('reloj--critico', restan <= 10);
    reloj.hidden = false;
  } else {
    reloj.hidden = true;
  }

  if (estado.fase === 'resumen' && estado.resumenHasta) {
    const restan = Math.max(0, Math.ceil((estado.resumenHasta - Date.now()) / 1000));
    $('resumen-cuenta').textContent = restan ? `Siguiente turno en ${restan}…` : 'Cambiando de turno…';
  }
}, 250);

$('btn-jugar').addEventListener('click', () => {
  const vista = $('vista-inicio');
  const titulo = vista.querySelector('.marca__titulo');
  const reducir = matchMedia('(prefers-reduced-motion: reduce)').matches;
  // FLIP: medimos el titulo antes y despues del cambio y animamos la diferencia.
  const antes = titulo.getBoundingClientRect();
  vista.classList.remove('portada');
  vista.classList.add('entrando');
  const despues = titulo.getBoundingClientRect();
  if (!reducir && titulo.animate) {
    const dx = antes.left + antes.width / 2 - (despues.left + despues.width / 2);
    const dy = antes.top + antes.height / 2 - (despues.top + despues.height / 2);
    const escala = antes.width / despues.width;
    for (const f of titulo.querySelectorAll('.ficha')) f.style.animation = 'none';
    titulo.animate(
      [{ transform: `translate(${dx}px, ${dy}px) scale(${escala})` }, { transform: 'none' }],
      { duration: 650, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }
    );
  }
  setTimeout(() => vista.classList.remove('entrando'), 1300);
  $('in-nombre').focus({ preventScroll: true });
});

/* ---------- invitacion: pedir nombre antes de entrar ---------- */

function pedirNombreInvitacion(codigo) {
  const dlg = $('dlg-nombre');
  if (dlg.open) return;
  $('dlg-nombre-codigo').textContent = codigo;
  $('dlg-nombre-input').value = localStorage.getItem('palabrear:nombre') || '';
  $('dlg-nombre-error').hidden = true;
  dlg.dataset.codigo = codigo;
  dlg.showModal();
  $('dlg-nombre-input').focus();
}

$('form-nombre').addEventListener('submit', (e) => {
  e.preventDefault();
  const dlg = $('dlg-nombre');
  const nombre = $('dlg-nombre-input').value.trim();
  const error = $('dlg-nombre-error');
  if (!nombre) {
    error.textContent = 'Escribe tu nombre para entrar.';
    error.hidden = false;
    return;
  }
  $('in-nombre').value = nombre;
  socket.emit('unirse', { codigo: dlg.dataset.codigo, nombre: miNombre() }, (r) => {
    if (!r || !r.ok) {
      error.textContent = (r && r.error) || 'No se pudo entrar a la sala.';
      error.hidden = false;
      return;
    }
    localStorage.setItem('palabrear:sala', r.codigo);
    dlg.close();
  });
});

$('dlg-nombre-cancelar').addEventListener('click', () => {
  const dlg = $('dlg-nombre');
  $('in-codigo').value = dlg.dataset.codigo || '';
  dlg.close();
  location.hash = '';
});

/* ---------- donacion ---------- */

$('btn-donar').addEventListener('click', () => $('dlg-donar').showModal());
for (const dlg of document.querySelectorAll('.dialogo')) {
  // Clic fuera del cuadro lo cierra (salvo el del nombre, que tiene sus botones).
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg && dlg.id === 'dlg-donar') dlg.close();
  });
}

/* arranque */
mostrarVista('inicio');
if (location.hash) {
  const codigo = location.hash.replace('#', '').toUpperCase();
  if (/^[A-Z0-9]{4,6}$/.test(codigo)) $('in-codigo').value = codigo;
}

for (const [check, input] of [['in-sin-limite', 'in-tiempo'], ['cfg-sin-limite', 'cfg-tiempo']]) {
  $(check).addEventListener('change', () => {
    $(input).disabled = $(check).checked;
  });
}
